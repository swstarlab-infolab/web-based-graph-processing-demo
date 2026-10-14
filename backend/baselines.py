"""Baseline SQL runners (Umbra, DuckDB) for the comparison panel.

Connects to a running Umbra PostgreSQL instance (default: localhost:5433)
and executes the reference SQL equivalent of each engine preset query.
"""

from __future__ import annotations

import multiprocessing
import os
import resource
import subprocess
import time
import logging

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# SQL Reference Queries
# Keyed by preset stem (filename without .json, case-insensitive match)
# ---------------------------------------------------------------------------

UMBRA_QUERIES: dict[str, str] = {

    # ═══════════════════════════════════════════════════════════════════════
    # Demo Paper Queries (S1–S20)
    # SQL definitions are in the D-series section below (D1–D17).
    # S→D aliases at file bottom map S-prefix filenames to D-prefix SQL.
    # S18–S20 (CRPQ+length) are defined inline at file bottom.
    # ═══════════════════════════════════════════════════════════════════════

    # ── Legacy Word Equality queries ──────────────────────────────────────

    # WE-q2-simple: KNOWS (single hop), same source
    "WE-q2-simple": """
SELECT SUM(CAST(cnt AS BIGINT) * cnt) AS total_count
FROM (
    SELECT Person1Id, COUNT(*) AS cnt
    FROM Person_knows_Person
    GROUP BY Person1Id
) t;
""",

    # WE-q3: KNOWS/KNOWS (2-hop distinct destinations), same source
    "WE-q3": """
SELECT SUM(CAST(cnt AS BIGINT) * cnt) AS total_count
FROM (
    SELECT k1.Person1Id AS src, COUNT(DISTINCT k2.Person2Id) AS cnt
    FROM Person_knows_Person k1
    JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
    GROUP BY k1.Person1Id
) t;
""",

    # WE-q4: KNOWS^3 (3-hop distinct destinations), same source
    "WE-q4": """
SELECT SUM(CAST(cnt AS BIGINT) * cnt) AS total_count
FROM (
    SELECT k1.Person1Id AS src, COUNT(DISTINCT k3.Person2Id) AS cnt
    FROM Person_knows_Person k1
    JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
    JOIN Person_knows_Person k3 ON k2.Person2Id = k3.Person1Id
    GROUP BY k1.Person1Id
) t;
""",

    # WE-q5: KNOWS{1,2} (1-2 hop), same source
    "WE-q5": """
SELECT
    (SELECT SUM(CAST(cnt AS BIGINT) * cnt) FROM (
        SELECT Person1Id AS src, COUNT(DISTINCT Person2Id) AS cnt
        FROM Person_knows_Person
        GROUP BY Person1Id
    ) t1)
    +
    (SELECT SUM(CAST(cnt AS BIGINT) * cnt) FROM (
        SELECT k1.Person1Id AS src, COUNT(DISTINCT k2.Person2Id) AS cnt
        FROM Person_knows_Person k1
        JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
        GROUP BY k1.Person1Id
    ) t2)
AS total_count;
""",

    # WE-q6: KNOWS{1,3} (1-3 hop), same source
    "WE-q6": """
SELECT
    (SELECT SUM(CAST(cnt AS BIGINT) * cnt) FROM (
        SELECT Person1Id AS src, COUNT(DISTINCT Person2Id) AS cnt
        FROM Person_knows_Person
        GROUP BY Person1Id
    ) t1)
    +
    (SELECT SUM(CAST(cnt AS BIGINT) * cnt) FROM (
        SELECT k1.Person1Id AS src, COUNT(DISTINCT k2.Person2Id) AS cnt
        FROM Person_knows_Person k1
        JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
        GROUP BY k1.Person1Id
    ) t2)
    +
    (SELECT SUM(CAST(cnt AS BIGINT) * cnt) FROM (
        SELECT k1.Person1Id AS src, COUNT(DISTINCT k3.Person2Id) AS cnt
        FROM Person_knows_Person k1
        JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
        JOIN Person_knows_Person k3 ON k2.Person2Id = k3.Person1Id
        GROUP BY k1.Person1Id
    ) t3)
AS total_count;
""",

    # WE-q7: KNOWS/HAS_INTEREST (2-hop mixed labels), same source
    "WE-q7": """
SELECT SUM(CAST(cnt AS BIGINT) * cnt) AS total_count
FROM (
    SELECT k.Person1Id AS src, COUNT(DISTINCT hi.TagId) AS cnt
    FROM Person_knows_Person k
    JOIN Person_hasInterest_Tag hi ON k.Person2Id = hi.PersonId
    GROUP BY k.Person1Id
) t;
""",

    # WE-q8: LIKES/REPLY_OF* (multi-hop mixed labels), same source
    "WE-q8": """
WITH RECURSIVE LikesReply(src, dest, hop) AS (
    SELECT l.PersonId, l.CommentId, 1
    FROM Person_likes_Comment l
    UNION ALL
    SELECT l.PersonId, l.PostId, 1
    FROM Person_likes_Post l
    UNION
    SELECT lr.src, r.Comment2Id, lr.hop + 1
    FROM LikesReply lr
    JOIN Comment_replyOf_Comment r ON lr.dest = r.Comment1Id
)
-- hop limit removed: REPLY_OF is a DAG (no cycles)
SELECT SUM(CAST(cnt AS BIGINT) * cnt) AS total_count
FROM (
    SELECT src, hop, COUNT(DISTINCT dest) AS cnt
    FROM LikesReply
    GROUP BY src, hop
) t;
""",

    # WE-q1: KNOWS* (Kleene star), same source — includes hop=0
    "WE-q1": """
WITH RECURSIVE KnowsHops(src, dest, hop) AS (
    SELECT personid, personid, 0 FROM Person
    UNION
    SELECT k.src, p.person2id, k.hop + 1
    FROM KnowsHops k
    JOIN Person_knows_Person p ON k.dest = p.person1id
    WHERE k.hop < 20
)
SELECT SUM(CAST(cnt AS BIGINT) * cnt) AS total_count
FROM (
    SELECT src, hop, COUNT(DISTINCT dest) AS cnt
    FROM KnowsHops
    GROUP BY src, hop
) t;
""",

    # ── RPQ length-constrained queries ────────────────────────────────────

    # q1-length: KNOWS* [2,4]
    "q1-length": """
WITH RECURSIVE KnowsHops(src, dest, hop) AS (
    SELECT person1id, person2id, 1 FROM Person_knows_Person
    UNION
    SELECT k.src, p.person2id, k.hop + 1
    FROM KnowsHops k
    JOIN Person_knows_Person p ON k.dest = p.person1id
    WHERE k.hop < 4
)
SELECT COUNT(*) FROM (
    SELECT DISTINCT src, dest FROM KnowsHops WHERE hop >= 2
) t;
""",

    # q2-length: HAS_MODERATOR?/KNOWS* [2,5]
    "q2-length": """
WITH RECURSIVE KnowsHops(src, dest, hop) AS (
    SELECT person1id, person2id, 1 FROM Person_knows_Person
    UNION
    SELECT k.src, p.person2id, k.hop + 1
    FROM KnowsHops k
    JOIN Person_knows_Person p ON k.dest = p.person1id
    WHERE k.hop < 5
)
SELECT COUNT(*) FROM (
    SELECT DISTINCT kh.src AS v1, kh.dest AS v2
    FROM KnowsHops kh
    WHERE kh.hop BETWEEN 2 AND 5
    UNION
    SELECT DISTINCT fhm.forumid + 10000000000000 AS v1, kh.dest AS v2
    FROM Forum fhm
    JOIN KnowsHops kh ON fhm.hasmoderator_personid = kh.src
    WHERE kh.hop BETWEEN 1 AND 4
) t;
""",

    # q3-length: HAS_MODERATOR/KNOWS* [2,5]
    "q3-length": """
WITH RECURSIVE KnowsHops(src, dest, hop) AS (
    SELECT person1id, person2id, 1 FROM Person_knows_Person
    UNION
    SELECT k.src, p.person2id, k.hop + 1
    FROM KnowsHops k
    JOIN Person_knows_Person p ON k.dest = p.person1id
    WHERE k.hop < 4
)
SELECT COUNT(*) FROM (
    SELECT DISTINCT fhm.forumid, kh.dest
    FROM Forum fhm
    JOIN KnowsHops kh ON fhm.hasmoderator_personid = kh.src
) t;
""",

    # q4-length: KNOWS/KNOWS/HAS_INTEREST/HAS_TYPE [4,4]
    "q4-length": """
SELECT COUNT(*) FROM (
    SELECT DISTINCT p1.person1id, tht.tagclassid
    FROM Person_knows_Person AS p1
    JOIN Person_knows_Person AS p2 ON p1.person2id = p2.person1id
    JOIN Person_hasInterest_Tag pit ON p2.person2id = pit.personid
    JOIN Tag_hasType_TagClass tht ON pit.tagid = tht.tagid
) t;
""",

    # q5-length: HAS_CREATOR/(LIKES/REPLY_OF*) [3,5]
    "q5-length": """
WITH RECURSIVE ReplyHops(src, dest, hop) AS (
    SELECT commentid, messageid, 1 FROM Comment_replyOf_Message
    UNION
    SELECT r.src, c.messageid, r.hop + 1
    FROM ReplyHops r
    JOIN Comment_replyOf_Message c ON r.dest = c.commentid
    WHERE r.hop < 3
)
SELECT COUNT(*) FROM (
    SELECT DISTINCT mhc.messageid, rh.dest
    FROM ReplyHops rh
    JOIN Person_likes_Message plm ON rh.src = plm.messageid
    JOIN Message_hasCreator_Person mhc ON plm.personid = mhc.personid
) t;
""",

    # q6-length: HAS_MODERATOR/KNOWS*/IS_LOCATED_IN [3,5]
    "q6-length": """
WITH RECURSIVE KnowsHops(src, dest, hop) AS (
    SELECT person1id, person2id, 1 FROM Person_knows_Person
    UNION
    SELECT k.src, p.person2id, k.hop + 1
    FROM KnowsHops k
    JOIN Person_knows_Person p ON k.dest = p.person1id
    WHERE k.hop < 3
)
SELECT COUNT(*) FROM (
    SELECT DISTINCT fhm.forumid, ploc.cityid
    FROM Forum fhm
    JOIN KnowsHops kh ON fhm.hasmoderator_personid = kh.src
    JOIN Person_isLocatedIn_City ploc ON kh.dest = ploc.personid
) t;
""",

    # ── Prefix WE queries ────────────────────────────────────────────────

    "WE-pq1": """
SELECT CAST(COUNT(*) AS BIGINT) AS total_count
FROM Person_knows_Person k1
JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id;
""",

    "WE-pq2": """
SELECT CAST(COUNT(*) AS BIGINT) AS total_count
FROM Person_knows_Person k
JOIN Person_hasInterest_Tag h ON k.Person2Id = h.PersonId;
""",

    "WE-pq3": """
WITH twohop AS (
    SELECT DISTINCT k1.Person1Id AS v1, k2.Person2Id AS v2
    FROM Person_knows_Person k1
    JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
),
knows_deg AS (
    SELECT Person1Id AS pid, COUNT(*) AS deg
    FROM Person_knows_Person GROUP BY Person1Id
)
SELECT SUM(CAST(kd.deg AS BIGINT)) AS total_count
FROM twohop t
JOIN knows_deg kd ON t.v2 = kd.pid;
""",

    "WE-pq4": """
WITH twohop AS (
    SELECT DISTINCT k1.Person1Id AS v1, k2.Person2Id AS v2
    FROM Person_knows_Person k1
    JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
),
hi_deg AS (
    SELECT PersonId AS pid, COUNT(*) AS deg
    FROM Person_hasInterest_Tag GROUP BY PersonId
)
SELECT SUM(CAST(hd.deg AS BIGINT)) AS total_count
FROM twohop t
JOIN hi_deg hd ON t.v2 = hd.pid;
""",

    "WE-pq5": """
SELECT CAST(COUNT(*) AS BIGINT) AS total_count
FROM Person_knows_Person k1
JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id;
""",

    "WE-pq6": """
SELECT CAST(COUNT(*) AS BIGINT) AS total_count
FROM Person_knows_Person k
JOIN Person_hasInterest_Tag h ON k.Person2Id = h.PersonId;
""",

    "WE-pq7": """
WITH twohop AS (
    SELECT DISTINCT k1.Person1Id AS v1, k2.Person2Id AS v2
    FROM Person_knows_Person k1
    JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
),
knows_deg AS (
    SELECT Person1Id AS pid, COUNT(*) AS deg
    FROM Person_knows_Person GROUP BY Person1Id
)
SELECT SUM(CAST(kd.deg AS BIGINT)) AS total_count
FROM twohop t
JOIN knows_deg kd ON t.v2 = kd.pid;
""",

    "WE-pq8": """
WITH twohop AS (
    SELECT DISTINCT k1.Person1Id AS v1, k2.Person2Id AS v2
    FROM Person_knows_Person k1
    JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
),
hi_deg AS (
    SELECT PersonId AS pid, COUNT(*) AS deg
    FROM Person_hasInterest_Tag GROUP BY PersonId
)
SELECT SUM(CAST(hd.deg AS BIGINT)) AS total_count
FROM twohop t
JOIN hi_deg hd ON t.v2 = hd.pid;
""",

    "WE-pq9": """
WITH RECURSIVE KnowsHops(src, dest, hop) AS (
    SELECT personid, personid, 0 FROM Person
    UNION
    SELECT k.src, p.Person2Id, k.hop + 1
    FROM KnowsHops k
    JOIN Person_knows_Person p ON k.dest = p.Person1Id
    WHERE k.hop < 20
),
distinct_hops AS (
    SELECT DISTINCT src, dest, hop FROM KnowsHops
),
knows_deg AS (
    SELECT Person1Id AS pid, COUNT(*) AS deg
    FROM Person_knows_Person GROUP BY Person1Id
)
SELECT SUM(CAST(kd.deg AS BIGINT)) AS total_count
FROM distinct_hops dh
JOIN knows_deg kd ON dh.dest = kd.pid;
""",

    # ── CRPQ + WE queries (lock-step branch) ──────────────────────────────

    # CRPQ-q1-WE:
    #   (v1)-[KNOWS^2]->(v2), (v1)-[KNOWS^2]->(v3), (v2)-[KNOWS]->(v4)
    #   WE(P1=KNOWS^2, P2=KNOWS^2, same): same_query
    #   Result = SUM_{(v1,v2,v4): v1->KNOWS^2->v2, v2->KNOWS->v4} cnt_2hop(v1)
    #          = SUM_{v1} cnt_2hop(v1) * SUM_{v2 in 2hop(v1)} out_degree_knows(v2)
    "CRPQ-q1-WE": """
WITH knows2hop AS (
    SELECT DISTINCT k1.person1id AS src, k2.person2id AS dst
    FROM person_knows_person k1
    JOIN person_knows_person k2 ON k1.person2id = k2.person1id
),
cnt2hop AS (
    SELECT src, COUNT(*) AS cnt FROM knows2hop GROUP BY src
),
out_deg AS (
    SELECT person1id, COUNT(*) AS deg FROM person_knows_person GROUP BY person1id
)
SELECT CAST(SUM(CAST(c.cnt AS BIGINT) * d.deg) AS BIGINT) AS total_count
FROM knows2hop kh
JOIN cnt2hop c ON kh.src = c.src
JOIN out_deg d ON kh.dst = d.person1id;
""",

    # CRPQ-q2-WE:
    #   (comment)-[REPLY_OF*]->(post), (person1)<-[HAS_CREATOR]-(comment),
    #   (post)-[HAS_CREATOR]->(person2), (person1)-[P1=KNOWS*]->(person2),
    #   (person1)-[P3=KNOWS^2]->(person3)
    #   WE(P1, P3, same): intersection = KNOWS^2 -> person1->KNOWS^2->person2 required
    #   Constraints: person1<>person2, person1<>person3
    #   Result = SUM_{valid (comment,post,person1,person2)} cnt_2hop(person1)
    "CRPQ-q2-WE": """
WITH knows2hop AS (
    SELECT DISTINCT k1.person1id AS src, k2.person2id AS dst
    FROM person_knows_person k1
    JOIN person_knows_person k2 ON k1.person2id = k2.person1id
),
cnt2hop AS (
    SELECT src, COUNT(*) AS cnt FROM knows2hop GROUP BY src
),
reply_chain(commentid, postid, depth) AS (
    SELECT commentid, postid, 0 FROM comment_replyof_post
    UNION ALL
    SELECT rcc.comment1id, rc.postid, rc.depth + 1
    FROM comment_replyof_comment rcc
    JOIN reply_chain rc ON rcc.comment2id = rc.commentid
)
-- hop limit removed: REPLY_OF is a DAG (no cycles)
SELECT CAST(SUM(CAST(c.cnt AS BIGINT)) AS BIGINT) AS total_count
FROM reply_chain rc
JOIN message_hascreator_person mc ON rc.commentid = mc.messageid
JOIN message_hascreator_person mp ON rc.postid = mp.messageid
JOIN knows2hop kh ON mc.personid = kh.src AND mp.personid = kh.dst
JOIN cnt2hop c ON kh.src = c.src
WHERE mc.personid <> mp.personid;
""",

    # CRPQ-q3-WE:
    #   (message)<-[P1=LIKES/REPLY_OF*]-(person), (message)-[HAS_CREATOR]->(creator),
    #   (tag)<-[HAS_TAG]-(message), (message2)<-[P2=LIKES/REPLY_OF]-(person)
    #   WE(P1, P2, same): intersection = LIKES/REPLY_OF (depth 2)
    #   Result = SUM_{(message,creator,tag,person): person->LIKES->X->REPLY_OF->message,
    #                 message has HAS_CREATOR and HAS_TAG}
    #            of cnt_likereply1(person)
    #   where cnt_likereply1(person) = |{msg2: person->LIKES->X->REPLY_OF->msg2}|
    "CRPQ-q3-WE": """
WITH RECURSIVE likesreply(src, dest, hop) AS (
    SELECT personid, commentid, 1 FROM person_likes_comment
    UNION ALL SELECT personid, postid, 1 FROM person_likes_post
    UNION
    SELECT lr.src, r.comment2id, lr.hop + 1
    FROM likesreply lr JOIN comment_replyof_comment r ON lr.dest = r.comment1id
),
-- hop limit removed: REPLY_OF is a DAG (no cycles)
lr_reach AS (
    SELECT src, hop, COUNT(DISTINCT dest) AS reach_cnt
    FROM likesreply GROUP BY src, hop
),
crpq_base AS (
    SELECT DISTINCT lr.src AS person, lr.dest AS message, lr.hop AS depth
    FROM likesreply lr
    JOIN message_hascreator_person mhc ON lr.dest = mhc.messageid
    JOIN message_hastag_tag mht ON lr.dest = mht.messageid
)
SELECT CAST(SUM(lrr.reach_cnt) AS BIGINT) AS total_count
FROM crpq_base cb
JOIN lr_reach lrr ON cb.person = lrr.src AND cb.depth = lrr.hop;
""",

    # CRPQ-q4-WE:
    #   (tag)<-[P1=REPLY_OF*/HAS_TAG]-(comment), (comment)-[HAS_TAG]->(tag2),
    #   (person)-[HAS_INTEREST]->(tag), (tag3)<-[P2=REPLY_OF/HAS_TAG]-(comment)
    #   WE(P1, P2, same): intersection = REPLY_OF/HAS_TAG (depth 2: 1 REPLY_OF + 1 HAS_TAG)
    #   Constraints: tag<>tag2, tag<>tag3, tag2<>tag3
    #   Path: comment->[REPLY_OF*]->msg->[HAS_TAG]->tag
    #   Result = SUM_{(comment,tag,tag2,person): valid at depth=1} (reach_cnt_depth1(comment) - 1)
    #   (-1 because tag3<>tag2; tag3<>tag is partially handled by reach_cnt counting all tags)
    "CRPQ-q4-WE": """
WITH RECURSIVE replychain(comment_src, node, depth) AS (
    SELECT c.commentid, c.commentid, 0 FROM comment c
    UNION
    SELECT rc.comment_src, r.comment2id, rc.depth + 1
    FROM replychain rc JOIN comment_replyof_comment r ON rc.node = r.comment1id
    UNION
    SELECT rc.comment_src, r.postid, rc.depth + 1
    FROM replychain rc JOIN comment_replyof_post r ON rc.node = r.commentid
),
-- hop limits removed: REPLY_OF is a DAG (no cycles)
comment_to_tag AS (
    SELECT DISTINCT rc.comment_src AS comment, mht.tagid AS tag, rc.depth
    FROM replychain rc JOIN message_hastag_tag mht ON rc.node = mht.messageid
),
tag_reach AS (
    SELECT comment, depth, COUNT(DISTINCT tag) AS reach_cnt
    FROM comment_to_tag GROUP BY comment, depth
),
crpq_base AS (
    SELECT DISTINCT ct.comment, ct.tag, ct.depth, mht2.tagid AS tag2
    FROM comment_to_tag ct
    JOIN message_hastag_tag mht2 ON ct.comment = mht2.messageid
    JOIN person_hasinterest_tag pit ON ct.tag = pit.tagid
    WHERE ct.tag <> mht2.tagid
)
SELECT CAST(SUM(CAST(tr.reach_cnt AS BIGINT) - 1) AS BIGINT) AS total_count
FROM crpq_base cb
JOIN tag_reach tr ON cb.comment = tr.comment AND cb.depth = tr.depth
WHERE tr.reach_cnt > 1;
""",

    # CRPQ-q5-WE:
    #   (person1)-[P1=KNOWS*]->(person2), (person1)-[P2=KNOWS^2]->(person3),
    #   (person2)-[HAS_INTEREST]->(tag), (forum)-[HAS_MEMBER]->(person1)
    #   WE(P1, P2, same): intersection = KNOWS^2 -> person1->KNOWS^2->person2 required
    #   Constraints: person1<>person2, person1<>person3, person2<>person3
    #   Result = SUM_{(person1,person2,tag,forum): valid, person1->KNOWS^2->person2} cnt_2hop(person1)
    "CRPQ-q5-WE": """
WITH knows2hop AS (
    SELECT DISTINCT k1.person1id AS src, k2.person2id AS dst
    FROM person_knows_person k1
    JOIN person_knows_person k2 ON k1.person2id = k2.person1id
),
cnt2hop AS (
    SELECT src, COUNT(*) AS cnt FROM knows2hop GROUP BY src
)
SELECT CAST(SUM(CAST(c.cnt AS BIGINT)) AS BIGINT) AS total_count
FROM knows2hop kh
JOIN person_hasinterest_tag pit ON kh.dst = pit.personid
JOIN forum_hasmember_person fhm ON kh.src = fhm.personid
JOIN cnt2hop c ON kh.src = c.src
WHERE kh.src <> kh.dst;
""",
}

# ── Demo queries ────────────────────────────────────────────────────────────

UMBRA_QUERIES["Demo-q1"] = """
SELECT COUNT(*) FROM Person_knows_Person;
"""

UMBRA_QUERIES["Demo-q2"] = """
SELECT COUNT(*) FROM (
    SELECT DISTINCT k1.Person1Id, k2.Person2Id
    FROM Person_knows_Person k1
    JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
) t;
"""

# Demo-q3: WE(KNOWS, KNOWS, same_source) — same as WE-q2-simple
UMBRA_QUERIES["Demo-q3"] = UMBRA_QUERIES["WE-q2-simple"]

# Demo-q4: WE(KNOWS/KNOWS, KNOWS/KNOWS, same_source) — same as WE-q3
UMBRA_QUERIES["Demo-q4"] = UMBRA_QUERIES["WE-q3"]

UMBRA_QUERIES["Demo-q5"] = """
SELECT COUNT(*) FROM (
    SELECT DISTINCT Person1Id AS v1, Person2Id AS v2 FROM Person_knows_Person
    UNION
    SELECT DISTINCT k1.Person1Id AS v1, k2.Person2Id AS v2
    FROM Person_knows_Person k1
    JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
) t;
"""

UMBRA_QUERIES["Demo-q6"] = """
SELECT COUNT(*) FROM (
    SELECT DISTINCT k1.Person1Id, k3.Person2Id
    FROM Person_knows_Person k1
    JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
    JOIN Person_knows_Person k3 ON k2.Person2Id = k3.Person1Id
) t;
"""

UMBRA_QUERIES["Demo-q7"] = """
SELECT COUNT(*) FROM (
    SELECT DISTINCT k.Person1Id, h.TagId
    FROM Person_knows_Person k
    JOIN Person_hasInterest_Tag h ON k.Person2Id = h.PersonId
) t;
"""

UMBRA_QUERIES["Demo-q8"] = """
WITH comment_post_creators AS (
    SELECT DISTINCT crp.CommentId, crp.MessageId,
        mc.PersonId AS person1,
        mp.PersonId AS person2
    FROM Comment_replyOf_Message crp
    JOIN Post p ON crp.MessageId = p.PostId
    JOIN Message_hasCreator_Person mc ON crp.CommentId = mc.MessageId
    JOIN Message_hasCreator_Person mp ON crp.MessageId = mp.MessageId
),
knows_hop0 AS (SELECT PersonId AS src, PersonId AS dst FROM Person),
knows_hop1 AS (SELECT Person1Id AS src, Person2Id AS dst FROM Person_knows_Person),
knows_hop2 AS (
    SELECT DISTINCT k1.Person1Id AS src, k2.Person2Id AS dst
    FROM Person_knows_Person k1 JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
),
KnowsReach AS (
    SELECT src, dst FROM knows_hop0
    UNION SELECT src, dst FROM knows_hop1
    UNION SELECT src, dst FROM knows_hop2
)
SELECT COUNT(*) FROM (
    SELECT DISTINCT cpc.CommentId, cpc.MessageId, cpc.person1, cpc.person2
    FROM comment_post_creators cpc
    JOIN KnowsReach kr ON kr.src = cpc.person1 AND kr.dst = cpc.person2
) t;
"""

# Suffix queries (sq) -- semantically symmetric to corresponding pq queries
UMBRA_QUERIES["WE-sq1"] = UMBRA_QUERIES["WE-pq1"]
UMBRA_QUERIES["WE-sq2"] = UMBRA_QUERIES["WE-pq2"]
UMBRA_QUERIES["WE-sq3"] = UMBRA_QUERIES["WE-pq3"]
UMBRA_QUERIES["WE-sq4"] = UMBRA_QUERIES["WE-pq4"]
UMBRA_QUERIES["WE-sq5"] = UMBRA_QUERIES["WE-pq5"]
UMBRA_QUERIES["WE-sq6"] = UMBRA_QUERIES["WE-pq6"]
UMBRA_QUERIES["WE-sq7"] = UMBRA_QUERIES["WE-pq7"]
UMBRA_QUERIES["WE-sq8"] = UMBRA_QUERIES["WE-pq8"]
UMBRA_QUERIES["WE-sq9"] = UMBRA_QUERIES["WE-pq9"]

# ═══════════════════════════════════════════════════════════════════════════
# Demo D Queries (D1–D17): RPQ, WE, Prefix WE
# SQL rewriting — standard recursive CTEs + JOINs + aggregation.
# Same SQL runs on both Umbra and DuckDB.
# ═══════════════════════════════════════════════════════════════════════════

# ── D1: RPQ REPLY_OF*/HAS_TAG ─────────────────────────────────────────────
# Path: v1 -[REPLY_OF^n]-> mid -[HAS_TAG]-> v2  (n >= 0)
# v1 = Comment/Post (Messages), v2 = Tag
# Forum also has HAS_TAG edges (Forum_hasTag_Tag) with 0 REPLY_OF hops.
UMBRA_QUERIES["D1-rpq-reply-tag-chain"] = """
WITH RECURSIVE reply_chain(v1, mid, hop) AS (
    SELECT CommentId, CommentId, 0 FROM Comment
    UNION ALL
    SELECT PostId, PostId, 0 FROM Post
    UNION
    SELECT rc.v1, rom.MessageId, rc.hop + 1
    FROM reply_chain rc
    JOIN Comment_replyOf_Message rom ON rc.mid = rom.CommentId
)
-- hop limit removed: REPLY_OF is a DAG (no cycles), so recursion terminates naturally
-- Compute Message and Forum parts separately to avoid ID collision in UNION
SELECT (
    SELECT CAST(COUNT(*) AS BIGINT) FROM (
        SELECT DISTINCT rc.v1, mht.TagId AS v2
        FROM reply_chain rc
        JOIN Message_hasTag_Tag mht ON rc.mid = mht.MessageId
    ) t1
) + (
    SELECT CAST(COUNT(*) AS BIGINT) FROM (
        SELECT DISTINCT ForumId, TagId FROM Forum_hasTag_Tag
    ) t2
) AS total_count
"""

# ── D2: RPQ LIKES?/REPLY_OF* ──────────────────────────────────────────────
# L(P1) = ε ∪ (LIKES | REPLY_OF) · REPLY_OF*
# ε accepted (q0 is both initial and final → every vertex v gives (v,v)).
# NOTE: AllVerts covers major vertex types. Minor types (City, Country,
#   Continent, University, Company) are omitted — negligible count.
UMBRA_QUERIES["D2-rpq-liked-reply-chain"] = """
WITH RECURSIVE
reply_star(src, dst, hop) AS (
    SELECT CommentId, CommentId, 0 FROM Comment
    UNION ALL
    SELECT PostId, PostId, 0 FROM Post
    UNION
    SELECT rs.src, rom.MessageId, rs.hop + 1
    FROM reply_star rs
    JOIN Comment_replyOf_Message rom ON rs.dst = rom.CommentId
)
-- hop limit removed: REPLY_OF is a DAG (no cycles), so recursion terminates naturally
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT plc.PersonId AS v1, rs.dst AS v2
    FROM Person_likes_Comment plc
    JOIN reply_star rs ON plc.CommentId = rs.src
    UNION
    SELECT DISTINCT plp.PersonId, rs.dst
    FROM Person_likes_Post plp
    JOIN reply_star rs ON plp.PostId = rs.src
    UNION
    SELECT DISTINCT rom.CommentId AS v1, rs.dst AS v2
    FROM Comment_replyOf_Message rom
    JOIN reply_star rs ON rom.MessageId = rs.src
) t
"""

# ── D3: RPQ (REPLY_OF|HAS_TAG)* ───────────────────────────────────────────
# Kleene star over two edge labels. ε accepted (q0 initial+final).
# REPLY_OF: Comment → Message;  HAS_TAG: Message → Tag, Forum → Tag
# Tags have no outgoing REPLY_OF/HAS_TAG → terminal.
# WARNING: expensive multi-label Kleene star, may be slow.
UMBRA_QUERIES["D3-rpq-mixed-reach"] = """
WITH RECURSIVE
mixed_edge(src, dst) AS (
    SELECT CommentId, MessageId FROM Comment_replyOf_Message
    UNION ALL
    SELECT MessageId, TagId FROM Message_hasTag_Tag
    UNION ALL
    SELECT ForumId, TagId FROM Forum_hasTag_Tag
),
mixed_reach(v1, mid) AS (
    SELECT CommentId, CommentId FROM Comment
    UNION ALL
    SELECT PostId, PostId FROM Post
    UNION ALL
    SELECT ForumId, ForumId FROM Forum
    UNION
    SELECT mr.v1, me.dst
    FROM mixed_reach mr
    JOIN mixed_edge me ON mr.mid = me.src
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT v1, mid AS v2 FROM mixed_reach
) t
"""

# ── D4: RPQ KNOWS*/LIKES* ─────────────────────────────────────────────────
# KNOWS*: Person→Person (Kleene). LIKES*: Person→Message (at most 1 hop,
# since Messages have no outgoing LIKES). So LIKES* = LIKES? effectively.
# ε accepted (q0 initial+final).
UMBRA_QUERIES["D4-rpq-friend-liked-content"] = """
WITH RECURSIVE
knows_star(src, dst, hop) AS (
    SELECT PersonId, PersonId, 0 FROM Person
    UNION
    SELECT ks.src, pkp.Person2Id, ks.hop + 1
    FROM knows_star ks
    JOIN Person_knows_Person pkp ON ks.dst = pkp.Person1Id
    WHERE ks.hop < 20
),
kd AS (SELECT DISTINCT src, dst FROM knows_star)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT src AS v1, dst AS v2 FROM kd
    UNION
    SELECT DISTINCT kd.src, plc.CommentId
    FROM kd
    JOIN Person_likes_Comment plc ON kd.dst = plc.PersonId
    UNION
    SELECT DISTINCT kd.src, plp.PostId
    FROM kd
    JOIN Person_likes_Post plp ON kd.dst = plp.PersonId
) t
"""

# ── D5: RPQ (HAS_CREATOR|HAS_MODERATOR)/KNOWS* ────────────────────────────
# v1:Forum → only HAS_MODERATOR applies (HAS_CREATOR = Message→Person).
# Path: Forum -[HAS_MODERATOR]-> Person -[KNOWS*]-> Person
# Note: hasModerator_PersonId is a column on Forum, not a separate table.
UMBRA_QUERIES["D5-rpq-creator-social"] = """
WITH RECURSIVE knows_reach(v1, dst, hop) AS (
    SELECT fhm.ForumId, fhm.PersonId, 0
    FROM Forum_hasModerator_Person fhm
    UNION
    SELECT kr.v1, pkp.Person2Id, kr.hop + 1
    FROM knows_reach kr
    JOIN Person_knows_Person pkp ON kr.dst = pkp.Person1Id
    WHERE kr.hop < 20
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT v1, dst AS v2 FROM knows_reach
) t
"""

# ── D6: WE KNOWS* = KNOWS* (same source, same_query) ──────────────────────
# Identical to WE-q1: SUM over (src, hop) of cnt(src,hop)²
UMBRA_QUERIES["D6-we-friend-equality"] = UMBRA_QUERIES["WE-q1"]

# ── D7: WE (KNOWS|HAS_INTEREST)* = (KNOWS|HAS_INTEREST)* ─────────────────
# Two-label Kleene star with WE. same_query=true.
# KNOWS: Person→Person, HAS_INTEREST: Person→Tag (terminal).
# Group by (src, hop), count distinct dst, SUM(cnt²).
# WARNING: expensive — reaches across Person+Tag vertex space.
UMBRA_QUERIES["D7-we-mixed-equality"] = """
WITH RECURSIVE
edges(src, dst) AS (
    SELECT Person1Id, Person2Id FROM Person_knows_Person
    UNION ALL
    SELECT PersonId, TagId FROM Person_hasInterest_Tag
),
mixed_reach(src, dst, hop) AS (
    SELECT PersonId, PersonId, 0 FROM Person
    UNION
    SELECT mr.src, e.dst, mr.hop + 1
    FROM mixed_reach mr
    JOIN edges e ON mr.dst = e.src
    WHERE mr.hop < 20
)
SELECT CAST(SUM(CAST(c AS BIGINT) * c) AS BIGINT) AS total_count
FROM (
    SELECT src, hop, COUNT(DISTINCT dst) AS c
    FROM mixed_reach
    GROUP BY src, hop
) t
"""

# ── D8: WE LIKES/REPLY_OF* = LIKES/REPLY_OF* (same source, same_query) ───
# Same semantics as WE-q8 but uses unified Comment_replyOf_Message table
# (compatible with both Umbra and DuckDB).
UMBRA_QUERIES["D8-we-like-reply-equality"] = """
WITH RECURSIVE LikesReply(src, dest, hop) AS (
    SELECT PersonId, CommentId, 1 FROM Person_likes_Comment
    UNION ALL
    SELECT PersonId, PostId, 1 FROM Person_likes_Post
    UNION
    SELECT lr.src, rom.MessageId, lr.hop + 1
    FROM LikesReply lr
    JOIN Comment_replyOf_Message rom ON lr.dest = rom.CommentId
)
-- hop limit removed: REPLY_OF is a DAG (no cycles)
SELECT CAST(SUM(CAST(cnt AS BIGINT) * cnt) AS BIGINT) AS total_count
FROM (
    SELECT src, hop, COUNT(DISTINCT dest) AS cnt
    FROM LikesReply
    GROUP BY src, hop
) t
"""

# ── D9: WE REPLY_OF*/HAS_TAG = REPLY_OF*/HAS_TAG (same source) ───────────
# Words: REPLY_OF^n · HAS_TAG for n >= 0.
# At each depth n, count distinct tags, then SUM(cnt²).
# Source vertices: Comments (follow REPLY_OF chain), Posts (n=0 only).
# Forum_hasTag_Tag also contributes at n=0.
UMBRA_QUERIES["D9-we-reply-tag-equality"] = """
WITH RECURSIVE reply_chain(src, mid, depth) AS (
    SELECT CommentId, CommentId, 0 FROM Comment
    UNION ALL
    SELECT PostId, PostId, 0 FROM Post
    UNION
    SELECT rc.src, rom.MessageId, rc.depth + 1
    FROM reply_chain rc
    JOIN Comment_replyOf_Message rom ON rc.mid = rom.CommentId
),
-- hop limit removed: REPLY_OF is a DAG (no cycles)
-- Compute Message and Forum WE counts separately to avoid ID collision
msg_tag_reach AS (
    SELECT DISTINCT rc.src, rc.depth, mht.TagId
    FROM reply_chain rc
    JOIN Message_hasTag_Tag mht ON rc.mid = mht.MessageId
),
msg_cnt AS (
    SELECT src, depth, COUNT(*) AS c FROM msg_tag_reach GROUP BY src, depth
),
forum_cnt AS (
    SELECT ForumId AS src, COUNT(*) AS c FROM Forum_hasTag_Tag GROUP BY ForumId
)
SELECT CAST(
    (SELECT COALESCE(SUM(CAST(c AS BIGINT) * c), 0) FROM msg_cnt) +
    (SELECT COALESCE(SUM(CAST(c AS BIGINT) * c), 0) FROM forum_cnt)
AS BIGINT) AS total_count
"""

# ── D10: WE REPLY_OF*/HAS_TAG ≠ (REPLY_OF|HAS_TAG)* (same source) ────────
# L(P1) ∩ L(P2) = L(P1) = {REPLY_OF^n · HAS_TAG}, same reachability → = D9
UMBRA_QUERIES["D10-we-diff-reply-tag"] = UMBRA_QUERIES["D9-we-reply-tag-equality"]

# ── D11: WE KNOWS*/(LIKES|HAS_INTEREST) ≠ KNOWS*/LIKES*/HAS_INTEREST? ────
# L(P1) ∩ L(P2) = KNOWS^n·LIKES ∪ KNOWS^n·HAS_INTEREST.
# For each word group, count distinct endpoints, SUM(cnt²).
# LIKES: Person→Message, HAS_INTEREST: Person→Tag.
# WARNING: KNOWS* Kleene star BFS is expensive.
UMBRA_QUERIES["D11-we-diff-friend-interest"] = """
WITH RECURSIVE knows_reach(src, mid, hop) AS (
    SELECT PersonId, PersonId, 0 FROM Person
    UNION
    SELECT kr.src, pkp.Person2Id, kr.hop + 1
    FROM knows_reach kr
    JOIN Person_knows_Person pkp ON kr.mid = pkp.Person1Id
    WHERE kr.hop < 20
),
kd AS (SELECT DISTINCT src, mid, hop FROM knows_reach),
likes_cnt AS (
    SELECT kd.src, kd.hop,
        COUNT(DISTINCT l.msg) AS c
    FROM kd
    JOIN (
        SELECT PersonId AS pid, CommentId AS msg FROM Person_likes_Comment
        UNION ALL
        SELECT PersonId AS pid, PostId AS msg FROM Person_likes_Post
    ) l ON kd.mid = l.pid
    GROUP BY kd.src, kd.hop
),
hi_cnt AS (
    SELECT kd.src, kd.hop,
        COUNT(DISTINCT phi.TagId) AS c
    FROM kd
    JOIN Person_hasInterest_Tag phi ON kd.mid = phi.PersonId
    GROUP BY kd.src, kd.hop
)
SELECT CAST(
    COALESCE((SELECT SUM(CAST(c AS BIGINT) * c) FROM likes_cnt), 0) +
    COALESCE((SELECT SUM(CAST(c AS BIGINT) * c) FROM hi_cnt), 0)
AS BIGINT) AS total_count
"""

# ── D12: WE (KNOWS|HAS_INTEREST)* ≠ KNOWS*/HAS_INTEREST? ─────────────────
# L(P1) ∩ L(P2) = KNOWS^n ∪ KNOWS^n·HAS_INTEREST.
# Two components: KNOWS^n endpoint count² + KNOWS^n·HI endpoint count².
# WARNING: KNOWS* Kleene star BFS is expensive.
UMBRA_QUERIES["D12-we-diff-mixed-friend"] = """
WITH RECURSIVE knows_reach(src, dst, hop) AS (
    SELECT PersonId, PersonId, 0 FROM Person
    UNION
    SELECT kr.src, pkp.Person2Id, kr.hop + 1
    FROM knows_reach kr
    JOIN Person_knows_Person pkp ON kr.dst = pkp.Person1Id
    WHERE kr.hop < 20
),
kd AS (SELECT DISTINCT src, dst, hop FROM knows_reach),
knows_cnt AS (
    SELECT src, hop, COUNT(*) AS c FROM kd GROUP BY src, hop
),
hi_cnt AS (
    SELECT kd.src, kd.hop,
        COUNT(DISTINCT phi.TagId) AS c
    FROM kd
    JOIN Person_hasInterest_Tag phi ON kd.dst = phi.PersonId
    GROUP BY kd.src, kd.hop
)
SELECT CAST(
    COALESCE((SELECT SUM(CAST(c AS BIGINT) * c) FROM knows_cnt), 0) +
    COALESCE((SELECT SUM(CAST(c AS BIGINT) * c) FROM hi_cnt), 0)
AS BIGINT) AS total_count
"""

# ── D13: WE LIKES/REPLY_OF* ≠ (LIKES|REPLY_OF)* ──────────────────────────
# L(P1) ∩ L(P2) = L(P1) = LIKES·REPLY_OF^n, same reachability → = D8
UMBRA_QUERIES["D13-we-diff-like-reply"] = UMBRA_QUERIES["D8-we-like-reply-equality"]

# ── D14: Prefix WE — KNOWS* ≺ KNOWS*, continuation KNOWS* ────────────────
# Count = Σ_{v1} Σ_{v2 ∈ KNOWS^k(v1)} suffix_distinct(v1, k) × total_reach(v2)
# suffix_distinct(v1, k) = |{v3 : ∃ m≥k, v3 ∈ KNOWS^m(v1)}|
# total_reach(v2) = |KNOWS*(v2)|
# WARNING: triple KNOWS* — extremely expensive, likely OOM on sf≥10.
UMBRA_QUERIES["D14-prefix-friend-chain"] = """
WITH RECURSIVE knows_reach(src, dst, hop) AS (
    SELECT PersonId, PersonId, 0 FROM Person
    UNION
    SELECT kr.src, pkp.Person2Id, kr.hop + 1
    FROM knows_reach kr
    JOIN Person_knows_Person pkp ON kr.dst = pkp.Person1Id
    WHERE kr.hop < 20
),
kd AS (SELECT DISTINCT src, dst, hop FROM knows_reach),
first_hop AS (
    SELECT src, dst, MIN(hop) AS min_hop FROM kd GROUP BY src, dst
),
first_cnt AS (
    SELECT src, min_hop, COUNT(*) AS fc FROM first_hop GROUP BY src, min_hop
),
suffix_distinct AS (
    SELECT src, min_hop AS k,
        SUM(fc) OVER (PARTITION BY src ORDER BY min_hop
            ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS sdist
    FROM first_cnt
),
total_reach AS (
    SELECT src, COUNT(DISTINCT dst) AS total_c FROM kd GROUP BY src
)
SELECT CAST(SUM(CAST(sd.sdist AS BIGINT) * CAST(tr.total_c AS BIGINT)) AS BIGINT) AS total_count
FROM first_hop fh
JOIN suffix_distinct sd ON fh.src = sd.src AND fh.min_hop = sd.k
JOIN total_reach tr ON fh.dst = tr.src
"""

# ── D15: Prefix WE — KNOWS* ≺ (KNOWS|HAS_INTEREST)*, continuation HAS_INTEREST
# P1 word = KNOWS^k. P2 suffix after prefix = (KNOWS|HI)* from mid.
# Count = Σ_{v1,k,v2∈KNOWS^k(v1)} P2_suffix(v1,k) × HI_deg(v2)
# P2_suffix(v1,k) = |{v3 : ∃ mid ∈ KNOWS^k(v1), v3 ∈ (KNOWS|HI)*(mid)}|
# WARNING: extremely expensive — KNOWS* BFS + mixed reachability.
# Simplified: compute mixed_reach per person, then aggregate.
UMBRA_QUERIES["D15-prefix-mixed-friend"] = """
WITH RECURSIVE
knows_reach(src, dst, hop) AS (
    SELECT PersonId, PersonId, 0 FROM Person
    UNION
    SELECT kr.src, pkp.Person2Id, kr.hop + 1
    FROM knows_reach kr
    JOIN Person_knows_Person pkp ON kr.dst = pkp.Person1Id
    WHERE kr.hop < 20
),
kd AS (SELECT DISTINCT src, dst, hop FROM knows_reach),
mixed_edges(src, dst) AS (
    SELECT Person1Id, Person2Id FROM Person_knows_Person
    UNION ALL
    SELECT PersonId, TagId FROM Person_hasInterest_Tag
),
mixed_reach(person_src, dst) AS (
    SELECT PersonId, PersonId FROM Person
    UNION
    SELECT mr.person_src, me.dst
    FROM mixed_reach mr
    JOIN mixed_edges me ON mr.dst = me.src
),
mixed_cnt AS (
    SELECT person_src, COUNT(DISTINCT dst) AS mcnt FROM mixed_reach GROUP BY person_src
),
hi_deg AS (
    SELECT PersonId AS pid, COUNT(*) AS deg FROM Person_hasInterest_Tag GROUP BY PersonId
),
first_hop AS (
    SELECT src, dst, MIN(hop) AS min_hop FROM kd GROUP BY src, dst
),
p2_suffix AS (
    SELECT fh.src, fh.min_hop AS k,
        SUM(mc.mcnt) AS p2_cnt
    FROM first_hop fh
    JOIN mixed_cnt mc ON fh.dst = mc.person_src
    GROUP BY fh.src, fh.min_hop
),
p2_suffix_cum AS (
    SELECT src, k,
        SUM(p2_cnt) OVER (PARTITION BY src ORDER BY k
            ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS suffix_p2
    FROM p2_suffix
)
SELECT CAST(SUM(CAST(ps.suffix_p2 AS BIGINT) * CAST(COALESCE(hd.deg, 0) AS BIGINT)) AS BIGINT)
    AS total_count
FROM first_hop fh
JOIN p2_suffix_cum ps ON fh.src = ps.src AND fh.min_hop = ps.k
LEFT JOIN hi_deg hd ON fh.dst = hd.pid
WHERE hd.deg IS NOT NULL
"""

# ── D16: Prefix WE — LIKES/REPLY_OF* ≺ LIKES/REPLY_OF*, cont HAS_TAG ─────
# P1=P2=LIKES/REPLY_OF* (same_query). P3=HAS_TAG (single hop).
# Words: LIKES·REPLY_OF^n. Prefix: LIKES·REPLY_OF^k ⊑ LIKES·REPLY_OF^m (k≤m).
# Count = Σ_{v1} Σ_{k≥1} Σ_{v2∈LR^k(v1)} suffix_lr(v1,k) × tag_deg(v2)
# suffix_lr(v1,k) = |{v3 : ∃ m≥k, v3 ∈ LIKES·REPLY_OF^(m-1)(v1)}|
UMBRA_QUERIES["D16-prefix-like-reply"] = """
WITH RECURSIVE lr(src, dst, depth) AS (
    SELECT PersonId, CommentId, 1 FROM Person_likes_Comment
    UNION ALL
    SELECT PersonId, PostId, 1 FROM Person_likes_Post
    UNION
    SELECT lr.src, rom.MessageId, lr.depth + 1
    FROM lr
    JOIN Comment_replyOf_Message rom ON lr.dst = rom.CommentId
),
-- hop limit removed: REPLY_OF is a DAG (no cycles)
lr_dedup AS (SELECT DISTINCT src, dst, depth FROM lr),
first_depth AS (
    SELECT src, dst, MIN(depth) AS min_d FROM lr_dedup GROUP BY src, dst
),
first_cnt AS (
    SELECT src, min_d, COUNT(*) AS fc FROM first_depth GROUP BY src, min_d
),
suffix_distinct AS (
    SELECT src, min_d AS k,
        SUM(fc) OVER (PARTITION BY src ORDER BY min_d
            ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS sdist
    FROM first_cnt
),
tag_deg AS (
    SELECT MessageId AS mid, COUNT(*) AS tdeg
    FROM Message_hasTag_Tag GROUP BY MessageId
)
SELECT CAST(SUM(CAST(sd.sdist AS BIGINT) * CAST(td.tdeg AS BIGINT)) AS BIGINT) AS total_count
FROM first_depth fd
JOIN suffix_distinct sd ON fd.src = sd.src AND fd.min_d = sd.k
JOIN tag_deg td ON fd.dst = td.mid
"""

# ── D17: Prefix WE — (KNOWS|HI) ≺ (KNOWS|HI)*, cont (KNOWS|HI) ──────────
# P1 = single hop (KNOWS or HAS_INTEREST). P2 = Kleene star.
# P1 is always a 1-letter prefix of any P2 word ≥ 1.
# HAS_INTEREST→Tag→no outgoing edges → P3 from Tag = 0. Only KNOWS prefix matters.
# Count = Σ_{v1} Σ_{v2∈KNOWS(v1)} mixed_reach_via_KNOWS(v1) × mixed_deg(v2)
# mixed_reach_via_KNOWS(v1) = |{v3: ∃ mid∈KNOWS(v1), v3 ∈ (KNOWS|HI)*(mid)}|
# mixed_deg(v2) = KNOWS_out_deg(v2) + HI_out_deg(v2)
UMBRA_QUERIES["D17-prefix-mixed-chain"] = """
WITH RECURSIVE
mixed_edges(src, dst) AS (
    SELECT Person1Id, Person2Id FROM Person_knows_Person
    UNION ALL
    SELECT PersonId, TagId FROM Person_hasInterest_Tag
),
mixed_reach(person_src, dst) AS (
    SELECT PersonId, PersonId FROM Person
    UNION
    SELECT mr.person_src, me.dst
    FROM mixed_reach mr
    JOIN mixed_edges me ON mr.dst = me.src
),
mixed_cnt AS (
    SELECT person_src, COUNT(DISTINCT dst) AS mcnt FROM mixed_reach GROUP BY person_src
),
knows_deg AS (
    SELECT Person1Id AS pid, COUNT(*) AS kdeg FROM Person_knows_Person GROUP BY Person1Id
),
hi_deg AS (
    SELECT PersonId AS pid, COUNT(*) AS hdeg FROM Person_hasInterest_Tag GROUP BY PersonId
),
p2_via_knows AS (
    SELECT k.Person1Id AS v1,
        SUM(mc.mcnt) AS p2_cnt
    FROM Person_knows_Person k
    JOIN mixed_cnt mc ON k.Person2Id = mc.person_src
    GROUP BY k.Person1Id
)
SELECT CAST(SUM(
    CAST(p2.p2_cnt AS BIGINT) * (COALESCE(kd.kdeg, 0) + COALESCE(hd.hdeg, 0))
) AS BIGINT) AS total_count
FROM Person_knows_Person pk
JOIN p2_via_knows p2 ON pk.Person1Id = p2.v1
LEFT JOIN knows_deg kd ON pk.Person2Id = kd.pid
LEFT JOIN hi_deg hd ON pk.Person2Id = hd.pid
WHERE COALESCE(kd.kdeg, 0) + COALESCE(hd.hdeg, 0) > 0
"""

# ═══════════════════════════════════════════════════════════════════════════
# S-prefix aliases (demo-query/S*.json) — map to D-prefix queries
# ═══════════════════════════════════════════════════════════════════════════

# ── S1: RPQ (KNOWS|HAS_INTEREST)* (Q10 pattern) — multi-label Kleene star ─
# engine handles; Umbra times out (T.O.) at SF≥1
UMBRA_QUERIES["S1-rpq-friend-transitive"] = """
WITH RECURSIVE social_star(src, dst) AS (
    SELECT PersonId, PersonId FROM Person
    UNION ALL
    SELECT TagId, TagId FROM Tag
    UNION
    SELECT ss.src, e.dst
    FROM social_star ss
    JOIN (
        SELECT Person1Id AS src, Person2Id AS dst FROM Person_knows_Person
        UNION ALL
        SELECT PersonId AS src, TagId AS dst FROM Person_hasInterest_Tag
    ) e ON ss.dst = e.src
)
SELECT CAST(COUNT(*) AS BIGINT) AS total_count FROM (
    SELECT DISTINCT src, dst FROM social_star
) t
"""

# ── S2: RPQ HAS_MODERATOR/KNOWS* (Q3 pattern) ────────────────────────────
# engine: ~1.1s, Umbra: ~18s → ~16x speedup
UMBRA_QUERIES["S2-rpq-forum-friend"] = """
WITH RECURSIVE knows_reach(v1, dst) AS (
    SELECT fhm.ForumId, fhm.PersonId
    FROM Forum_hasModerator_Person fhm
    UNION
    SELECT kr.v1, pkp.Person2Id
    FROM knows_reach kr
    JOIN Person_knows_Person pkp ON kr.dst = pkp.Person1Id
)
SELECT CAST(COUNT(*) AS BIGINT) AS total_count FROM (
    SELECT DISTINCT v1, dst AS v2 FROM knows_reach
) t
"""

# ── S3: RPQ KNOWS/KNOWS/HAS_INTEREST/HAS_TYPE (Q4 pattern) ──────────────
# Non-recursive 4-hop join. engine: ~0.1s, Umbra: ~28s → ~280x speedup
UMBRA_QUERIES["S3-rpq-friend-interest"] = """
SELECT CAST(COUNT(*) AS BIGINT) AS total_count FROM (
    SELECT DISTINCT p1.person1id AS v1, tht.tagclassid AS v2
    FROM Person_knows_Person AS p1
    JOIN Person_knows_Person AS p2 ON p1.person2id = p2.person1id
    JOIN Person_hasInterest_Tag pit ON p2.person2id = pit.personid
    JOIN Tag_hasType_TagClass tht ON pit.tagid = tht.tagid
) t
"""

# ── S4: RPQ HAS_MODERATOR/KNOWS*/IS_LOCATED_IN (Q6 pattern) ─────────────
# engine: ~0.2s, Umbra: ~2.4s → ~12x speedup
UMBRA_QUERIES["S4-rpq-forum-city"] = """
WITH RECURSIVE knows_star(src, dst) AS (
    SELECT Person1Id, Person2Id FROM Person_knows_Person
    UNION
    SELECT ks.src, pkp.Person2Id
    FROM knows_star ks
    JOIN Person_knows_Person pkp ON ks.dst = pkp.Person1Id
)
SELECT CAST(COUNT(*) AS BIGINT) AS total_count FROM (
    SELECT DISTINCT fhm.ForumId AS v1, ploc.CityId AS v2
    FROM Forum_hasModerator_Person fhm
    JOIN knows_star ks ON fhm.PersonId = ks.src
    JOIN Person_isLocatedIn_City ploc ON ks.dst = ploc.PersonId
    UNION
    SELECT fhm.ForumId AS v1, ploc.CityId AS v2
    FROM Forum_hasModerator_Person fhm
    JOIN Person_isLocatedIn_City ploc ON fhm.PersonId = ploc.PersonId
) t
"""

# ── S5: RPQ HAS_MODERATOR?/(KNOWS|HAS_INTEREST)* — multi-label Kleene ─────
# Optional moderator + multi-label traversal. engine handles; Umbra T.O.
UMBRA_QUERIES["S5-rpq-optional-moderator"] = """
WITH RECURSIVE social_star(src, dst) AS (
    SELECT PersonId, PersonId FROM Person
    UNION ALL
    SELECT TagId, TagId FROM Tag
    UNION
    SELECT ss.src, e.dst
    FROM social_star ss
    JOIN (
        SELECT Person1Id AS src, Person2Id AS dst FROM Person_knows_Person
        UNION ALL
        SELECT PersonId AS src, TagId AS dst FROM Person_hasInterest_Tag
    ) e ON ss.dst = e.src
)
SELECT CAST(COUNT(*) AS BIGINT) AS total_count FROM (
    SELECT DISTINCT src AS v1, dst AS v2 FROM social_star
    UNION
    SELECT DISTINCT fhm.ForumId AS v1, ss.dst AS v2
    FROM Forum_hasModerator_Person fhm
    JOIN social_star ss ON fhm.PersonId = ss.src
) t
"""
# ── S-series aliases → D-prefix SQL ──────────────────────────────────────────
UMBRA_QUERIES["S4-rpq-friend-liked-content"] = UMBRA_QUERIES["D4-rpq-friend-liked-content"]
UMBRA_QUERIES["S5-rpq-creator-social"] = UMBRA_QUERIES["D5-rpq-creator-social"]

UMBRA_QUERIES["S6-we-friend-equality"] = UMBRA_QUERIES["D6-we-friend-equality"]
UMBRA_QUERIES["S9-we-diff-friend-interest"] = UMBRA_QUERIES["D11-we-diff-friend-interest"]
UMBRA_QUERIES["S11-prefix-friend-chain"] = UMBRA_QUERIES["D14-prefix-friend-chain"]
UMBRA_QUERIES["S12-prefix-mixed-friend"] = UMBRA_QUERIES["D15-prefix-mixed-friend"]
UMBRA_QUERIES["S14-prefix-mixed-chain"] = UMBRA_QUERIES["D17-prefix-mixed-chain"]

# ═══════════════════════════════════════════════════════════════════════════
# S15–S17: CRPQ with Length Constraints
# ═══════════════════════════════════════════════════════════════════════════

# ── S15: CRPQ — comment→REPLY_OF→post, comment→HAS_CREATOR→person1,
#    post→HAS_CREATOR→person2, person1→KNOWS{1,3}→person2 ─────────────────
# 4-vertex triangle: Comment replies to Post, their creators linked by 1-3 KNOWS hops.
UMBRA_QUERIES["S15-crpq-length-friend-triangle"] = """
WITH
knows_hop1 AS (
    SELECT DISTINCT Person1Id AS src, Person2Id AS dst FROM Person_knows_Person
),
knows_hop2 AS (
    SELECT DISTINCT k1.Person1Id AS src, k2.Person2Id AS dst
    FROM Person_knows_Person k1
    JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
),
knows_hop3 AS (
    SELECT DISTINCT k1.Person1Id AS src, k3.Person2Id AS dst
    FROM Person_knows_Person k1
    JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
    JOIN Person_knows_Person k3 ON k2.Person2Id = k3.Person1Id
),
knows_reach AS (
    SELECT src, dst FROM knows_hop1
    UNION SELECT src, dst FROM knows_hop2
    UNION SELECT src, dst FROM knows_hop3
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT rom.CommentId AS comment, p.PostId AS post,
        mc.PersonId AS person1, mp.PersonId AS person2
    FROM Comment_replyOf_Message rom
    JOIN Post p ON rom.MessageId = p.PostId
    JOIN Message_hasCreator_Person mc ON rom.CommentId = mc.MessageId
    JOIN Message_hasCreator_Person mp ON p.PostId = mp.MessageId
    JOIN knows_reach kr ON mc.PersonId = kr.src
                       AND mp.PersonId = kr.dst
) t
"""

# ── S16: CRPQ — (tag)<-[P1=REPLY_OF{1,3}/HAS_TAG]-(comment),
#    (comment)-[HAS_TAG]->(tag2), (person)-[HAS_INTEREST]->(tag), tag<>tag2 ──
# Find (comment, tag, tag2, person) where comment reaches tag via 1-3 REPLY_OF
# hops then HAS_TAG, comment also directly has a different tag2, and some person
# has interest in that tag.
UMBRA_QUERIES["S16-crpq-length-friend-interest"] = """
WITH RECURSIVE reply_chain(src, mid, depth) AS (
    SELECT CommentId, CommentId, 0 FROM Comment
    UNION
    SELECT rc.src, rom.MessageId, rc.depth + 1
    FROM reply_chain rc
    JOIN Comment_replyOf_Message rom ON rc.mid = rom.CommentId
    WHERE rc.depth < 3
),
rpq_tag AS (
    SELECT DISTINCT rc.src AS comment, mht.TagId AS tag
    FROM reply_chain rc
    JOIN Message_hasTag_Tag mht ON rc.mid = mht.MessageId
    WHERE rc.depth >= 1
),
comment_tag AS (
    SELECT mht.MessageId AS comment, mht.TagId AS tag2
    FROM Message_hasTag_Tag mht
    WHERE mht.MessageId IN (SELECT CommentId FROM Comment)
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT rt.comment, rt.tag, ct.tag2, phi.PersonId AS person
    FROM rpq_tag rt
    JOIN comment_tag ct ON rt.comment = ct.comment
    JOIN Person_hasInterest_Tag phi ON rt.tag = phi.TagId
    WHERE rt.tag <> ct.tag2
) t
"""


# ═══════════════════════════════════════════════════════════════════════════
# S10: Different-source Word Equality
# ═══════════════════════════════════════════════════════════════════════════

# ── S10: WE asymmetric automata (diff-source, KNOWS link) ────────────────
# P1: KNOWS*/HAS_INTEREST/HAS_TYPE from v1 (structured: social→interest→category)
# P2: (KNOWS|HAS_INTEREST)*/HAS_TYPE from v2 (flexible: mixed→category)
# WE matching sequences = L(P1) ∩ L(P2) = KNOWS^n·HAS_INTEREST·HAS_TYPE (n≥0).
# P2 paths not in L(P1) (e.g. HAS_INTEREST·KNOWS·HAS_TYPE) have no P1 match
# → only KNOWS*/HAS_INTEREST/HAS_TYPE paths from v2 contribute to the count.
# So cnt1 and cnt2 use the same CTE structure; WE count = Σ cnt1[v1,k]×cnt2[v2,k].
# WARNING: requires full KNOWS* transitive closure — T.O./OOM on sf≥1.
UMBRA_QUERIES["S10-we-diff-source-friend"] = """
WITH RECURSIVE knows_reach(src, mid, depth) AS (
    SELECT personid, personid, 0 FROM Person
    UNION
    SELECT kr.src, pkp.person2id, kr.depth + 1
    FROM knows_reach kr
    JOIN Person_knows_Person pkp ON kr.mid = pkp.person1id
),
paths AS (
    SELECT kr.src, tht.tagclassid, kr.depth + 2 AS total_depth
    FROM knows_reach kr
    JOIN Person_hasInterest_Tag pit ON kr.mid = pit.personid
    JOIN Tag_hasType_TagClass tht ON pit.tagid = tht.tagid
),
cnt AS (
    SELECT src, total_depth, COUNT(DISTINCT tagclassid) AS c
    FROM paths
    GROUP BY src, total_depth
)
SELECT CAST(SUM(CAST(c1.c AS BIGINT) * CAST(c2.c AS BIGINT)) AS BIGINT) AS total_count
FROM Person_knows_Person pkp
JOIN cnt c1 ON pkp.person1id = c1.src
JOIN cnt c2 ON pkp.person2id = c2.src AND c1.total_depth = c2.total_depth
"""

# ═══════════════════════════════════════════════════════════════════════════
# S18–S19: RPQ with Length Bounds (extensions of S1/S4)
# ═══════════════════════════════════════════════════════════════════════════

# ── S18: RPQ KNOWS{1,3}/LIKES* — bounded version of S4 ───────────────────
# S4 = KNOWS*/LIKES* (unbounded). S18 limits KNOWS to 1-3 hops.
# LIKES*: Person→Message (at most 1 hop, since Messages have no outgoing LIKES).
# Path: Person -[KNOWS{1,3}]-> Person -[LIKES?]-> Message
UMBRA_QUERIES["S18-rpq-length-friend-liked"] = """
WITH
knows_hop1 AS (
    SELECT DISTINCT Person1Id AS src, Person2Id AS dst FROM Person_knows_Person
),
knows_hop2 AS (
    SELECT DISTINCT k1.Person1Id AS src, k2.Person2Id AS dst
    FROM Person_knows_Person k1
    JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
),
knows_hop3 AS (
    SELECT DISTINCT k1.Person1Id AS src, k3.Person2Id AS dst
    FROM Person_knows_Person k1
    JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
    JOIN Person_knows_Person k3 ON k2.Person2Id = k3.Person1Id
),
knows_reach AS (
    SELECT src, dst FROM knows_hop1
    UNION SELECT src, dst FROM knows_hop2
    UNION SELECT src, dst FROM knows_hop3
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT src AS v1, dst AS v2 FROM knows_reach
    UNION
    SELECT DISTINCT kr.src, plc.CommentId
    FROM knows_reach kr
    JOIN Person_likes_Comment plc ON kr.dst = plc.PersonId
    UNION
    SELECT DISTINCT kr.src, plp.PostId
    FROM knows_reach kr
    JOIN Person_likes_Post plp ON kr.dst = plp.PersonId
) t
"""

# ═══════════════════════════════════════════════════════════════════════════
# S20–S23: KNOWS*-based scenarios
# ═══════════════════════════════════════════════════════════════════════════

# ── S20: RPQ KNOWS* — pure transitive closure of KNOWS ──────────────────
UMBRA_QUERIES["S20-rpq-knows-star"] = """
WITH RECURSIVE knows_star(src, dst) AS (
    SELECT PersonId, PersonId FROM Person
    UNION
    SELECT ks.src, pkp.Person2Id
    FROM knows_star ks
    JOIN Person_knows_Person pkp ON ks.dst = pkp.Person1Id
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT src, dst FROM knows_star
) t
"""

# ── S21: RPQ (HAS_CREATOR|HAS_MEMBER|HAS_MODERATOR)/KNOWS* ─────────────
# Start from any entity via one of three edges, then traverse KNOWS*.
UMBRA_QUERIES["S21-rpq-multi-start-knows"] = """
WITH RECURSIVE knows_star(src, dst) AS (
    SELECT PersonId, PersonId FROM Person
    UNION
    SELECT ks.src, pkp.Person2Id
    FROM knows_star ks
    JOIN Person_knows_Person pkp ON ks.dst = pkp.Person1Id
),
initial_edges AS (
    SELECT MessageId AS v1, PersonId AS v2 FROM Message_hasCreator_Person
    UNION ALL
    SELECT ForumId, PersonId FROM Forum_hasMember_Person
    UNION ALL
    SELECT ForumId, PersonId FROM Forum_hasModerator_Person
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT ie.v1, ks.dst AS v2
    FROM initial_edges ie
    JOIN knows_star ks ON ie.v2 = ks.src
) t
"""

# ── S22: CRPQ — triangle: comment→REPLY_OF→post,
#    person1←HAS_CREATOR←comment, post→HAS_CREATOR→person2,
#    person1→KNOWS*→person2 ────────────────────────────────────────────────
UMBRA_QUERIES["S22-crpq-knows-triangle"] = """
WITH RECURSIVE knows_star(src, dst) AS (
    SELECT PersonId, PersonId FROM Person
    UNION
    SELECT ks.src, pkp.Person2Id
    FROM knows_star ks
    JOIN Person_knows_Person pkp ON ks.dst = pkp.Person1Id
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT crm.CommentId AS comment, crm.MessageId AS post,
        mc.PersonId AS person1, mp.PersonId AS person2
    FROM Comment_replyOf_Message crm
    JOIN Message_hasCreator_Person mc ON crm.CommentId = mc.MessageId
    JOIN Message_hasCreator_Person mp ON crm.MessageId = mp.MessageId
    JOIN knows_star ks ON mc.PersonId = ks.src AND mp.PersonId = ks.dst
) t
"""

# ── S23: CRPQ — person1→KNOWS*→person2, person2→HAS_INTEREST→tag,
#    forum→HAS_MEMBER→person1 ─────────────────────────────────────────────
UMBRA_QUERIES["S23-crpq-knows-interest-member"] = """
WITH RECURSIVE knows_star(src, dst) AS (
    SELECT PersonId, PersonId FROM Person
    UNION
    SELECT ks.src, pkp.Person2Id
    FROM knows_star ks
    JOIN Person_knows_Person pkp ON ks.dst = pkp.Person1Id
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT fmp.ForumId AS forum, fmp.PersonId AS person1,
        ks.dst AS person2, phi.TagId AS tag
    FROM Forum_hasMember_Person fmp
    JOIN knows_star ks ON fmp.PersonId = ks.src
    JOIN Person_hasInterest_Tag phi ON ks.dst = phi.PersonId
) t
"""


# ---------------------------------------------------------------------------
# Memory measurement helpers
# ---------------------------------------------------------------------------


def _get_rss_gb(pid: int) -> float:
    """Get VmRSS of a process in GB from /proc/{pid}/status."""
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    kb = int(line.split()[1])
                    return kb / (1024 * 1024)
    except Exception:
        pass
    return 0.0


def _get_container_pid(container: str) -> int | None:
    """Get the main PID of a Docker container via docker inspect."""
    try:
        result = subprocess.run(
            ["docker", "inspect", "--format", "{{.State.Pid}}", container],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return int(result.stdout.strip())
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# Worker subprocesses
# ---------------------------------------------------------------------------


def _umbra_worker(sql: str, host: str, port: int, q: multiprocessing.Queue) -> None:
    try:
        import psycopg2
        conn = psycopg2.connect(host=host, port=port,
                                user="postgres", password=os.environ.get("UMBRA_PASSWORD", "postgres"),
                                connect_timeout=5)
        conn.autocommit = True
        cur = conn.cursor()
        t0 = time.time()
        cur.execute(sql)
        row = cur.fetchone()
        elapsed = (time.time() - t0) * 1000.0
        cur.close()
        conn.close()
        q.put({"count": int(row[0]) if row and row[0] is not None else 0,
               "elapsed_ms": elapsed})
    except Exception as e:
        q.put({"error": str(e)[:300]})


def _duckdb_worker(adapted_sql: str, db_path: str, q: multiprocessing.Queue) -> None:
    try:
        import duckdb
        conn = duckdb.connect(db_path, read_only=True)
        conn.execute(
            "CREATE OR REPLACE TEMP VIEW Comment_replyOf_Message_u AS "
            "SELECT CommentId, ParentMessageId AS MessageId FROM Comment_replyOf_Message"
        )
        conn.execute(
            "CREATE OR REPLACE TEMP VIEW Tag_hasType_TagClass AS "
            "SELECT TagId, hasType_TagClassId AS TagClassId FROM Tag"
        )
        # DuckDB uses hasCreator_PersonId; Umbra uses PersonId.
        # Create a compatibility view so the same SQL works for both.
        conn.execute(
            "CREATE OR REPLACE TEMP VIEW Message_hasCreator_Person_u AS "
            "SELECT MessageId, hasCreator_PersonId AS PersonId FROM Message_hasCreator_Person"
        )
        # DuckDB stores hasModerator_PersonId as a column on Forum;
        # Umbra has a separate Forum_hasModerator_Person table.
        conn.execute(
            "CREATE OR REPLACE TEMP VIEW Forum_hasModerator_Person AS "
            "SELECT ForumId, hasModerator_PersonId AS PersonId FROM Forum "
            "WHERE hasModerator_PersonId IS NOT NULL"
        )
        # Same story for the two relations the LSQB load keeps as columns
        # rather than tables.  Their absence surfaced as a raw DuckDB
        # "Catalog Error" in the demo (R5 / S4-rpq-forum-city).
        conn.execute(
            "CREATE OR REPLACE TEMP VIEW Person_isLocatedIn_City AS "
            "SELECT PersonId, isLocatedIn_CityId AS CityId FROM Person "
            "WHERE isLocatedIn_CityId IS NOT NULL"
        )
        conn.execute(
            "CREATE OR REPLACE TEMP VIEW Comment_replyOf_Comment AS "
            "SELECT CommentId AS Comment1Id, replyOf_CommentId AS Comment2Id "
            "FROM Comment WHERE replyOf_CommentId IS NOT NULL"
        )
        t0 = time.time()
        row = conn.execute(adapted_sql).fetchone()
        elapsed = (time.time() - t0) * 1000.0
        conn.close()
        q.put({"count": int(row[0]) if row and row[0] is not None else 0,
               "elapsed_ms": elapsed})
    except Exception as e:
        q.put({"error": str(e)[:300]})


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


_CRASH_PATTERNS = (
    "connection unexpectedly",
    "Connection refused",
    "timeout expired",
    "timeout",
)


def _maybe_restart_umbra(error_msg: str, container: str, port: int = 5435) -> None:
    """Restart the Umbra container if the error indicates a crash or timeout."""
    if not any(pat in error_msg for pat in _CRASH_PATTERNS):
        return
    logger.warning("Umbra appears crashed/stuck (%s…), restarting container %s",
                   error_msg[:80], container)
    _restart_umbra(container, port)


def _restart_umbra(container: str, port: int = 5435) -> None:
    """Restart the container unconditionally.

    The OOM path has to come through here rather than _maybe_restart_umbra:
    "out of memory" matches none of _CRASH_PATTERNS, so routing it through the
    guard silently skipped the restart and left the server resident at ~940 GB.
    Every later query then tripped the threshold before running, and the box had
    16 GB free with the GPU daemons still on it.
    """
    try:
        subprocess.run(
            ["docker", "restart", container],
            capture_output=True, timeout=30,
        )
        # Wait for Umbra to accept connections.  Freeing ~1 TB takes the kernel
        # a while, so this is a minute, not the 15 s it used to be.
        import psycopg2
        for _ in range(120):
            time.sleep(0.5)
            try:
                conn = psycopg2.connect(
                    host="127.0.0.1", port=port,
                    user="postgres", password=os.environ.get("UMBRA_PASSWORD", "postgres"),
                    connect_timeout=2,
                )
                conn.close()
                logger.info("Umbra container %s restarted successfully", container)
                return
            except Exception:
                pass
        logger.warning("Umbra container %s restarted but not accepting connections yet", container)
    except Exception as e:
        logger.error("Failed to restart Umbra container %s: %s", container, e)


def _lookup_sql(preset_filename: str) -> str | None:
    stem = preset_filename.replace(".json", "").strip()
    sql = UMBRA_QUERIES.get(stem)
    if sql is None:
        for k, v in UMBRA_QUERIES.items():
            if k.lower() == stem.lower():
                return v
    return sql


def run_umbra_query(
    preset_filename: str,
    umbra_host: str = "127.0.0.1",
    umbra_port: int = 5435,
    timeout_sec: int = 120,
    container: str = "umbra-sf1",
) -> dict:
    """Run Umbra SQL in a subprocess while polling the Docker container RSS.

    Returns:
        {
          "supported": bool,
          "total_count": int | None,
          "elapsed_ms": float | None,
          "peak_rss_gb": float | None,
          "error": str | None,
        }
    """
    sql = _lookup_sql(preset_filename)
    if sql is None:
        return {"supported": False, "total_count": None, "elapsed_ms": None,
                "peak_rss_gb": None, "error": None}

    container_pid = _get_container_pid(container)
    baseline_rss = _get_rss_gb(container_pid) if container_pid else 0.0

    q: multiprocessing.Queue = multiprocessing.Queue()
    proc = multiprocessing.Process(target=_umbra_worker,
                                   args=(sql, umbra_host, umbra_port, q))
    proc.start()

    poll_interval = 0.1
    elapsed_wall = 0.0
    peak_rss = baseline_rss

    # One number, and the one the error quotes. The pair used to disagree --
    # the kill fired at 680 while the message claimed 700 -- so a stopped query
    # reported "680.0 GB >= 700 GB" and read as a bug in the guard rather than a
    # query that ran out of room. This box has 1007 GB, so cutting at 700 still
    # leaves ~300 GB of headroom for the overshoot the early kill was buying.
    OOM_THRESHOLD_GB = 700.0
    OOM_KILL_THRESHOLD_GB = OOM_THRESHOLD_GB
    while proc.is_alive():
        proc.join(timeout=poll_interval)
        elapsed_wall += poll_interval
        if proc.is_alive():
            crss = _get_rss_gb(container_pid) if container_pid else 0.0
            if crss > peak_rss:
                peak_rss = crss
            if peak_rss >= OOM_KILL_THRESHOLD_GB:
                proc.kill()
                proc.join(timeout=5)
                # Restart Umbra.  Severing the connection was assumed to make it
                # abort and hand the memory back; it does not -- a killed S6 left
                # the container resident at 923 GB, so every later query tripped
                # the guard at once and reported an OOM it never reached. On a
                # 1007 GB box that also starves the GPU daemons.
                _restart_umbra(container, umbra_port)
                return {
                    "supported": True, "total_count": None, "elapsed_ms": None,
                    "peak_rss_gb": round(peak_rss, 2),
                    "error": f"Out of memory ({round(peak_rss, 1)} GB ≥ {int(OOM_THRESHOLD_GB)} GB)",
                }
            if elapsed_wall >= timeout_sec:
                proc.kill()
                proc.join(timeout=5)
                # Restart Umbra after timeout — the timed-out query may leave
                # the server in a bad state (stuck locks, leaked memory).
                _maybe_restart_umbra("timeout", container, umbra_port)
                return {
                    "supported": True, "total_count": None, "elapsed_ms": None,
                    "peak_rss_gb": round(peak_rss, 2),
                    "error": f"Timed out after {timeout_sec}s",
                }

    # One final RSS read after the query finishes
    crss = _get_rss_gb(container_pid) if container_pid else 0.0
    if crss > peak_rss:
        peak_rss = crss

    result = q.get(block=False) if not q.empty() else {}

    if "error" in result:
        error_msg = result["error"]
        # Detect Umbra crash/OOM and auto-restart the container
        _maybe_restart_umbra(error_msg, container, umbra_port)
        return {
            "supported": True, "total_count": None, "elapsed_ms": None,
            "peak_rss_gb": round(peak_rss, 2),
            "error": error_msg,
        }

    return {
        "supported": True,
        "total_count": result.get("count"),
        "elapsed_ms": result.get("elapsed_ms"),
        "peak_rss_gb": round(peak_rss, 2),
        "error": None,
    }


def list_supported_presets() -> list[str]:
    """Return sorted list of preset stems with Umbra SQL defined."""
    return sorted(UMBRA_QUERIES.keys())


def run_duckdb_query(
    preset_filename: str,
    duckdb_path: str,
) -> dict:
    """Run DuckDB SQL in a subprocess and measure peak child RSS.

    Returns same shape as run_umbra_query().
    """
    sql = _lookup_sql(preset_filename)
    if sql is None:
        return {"supported": False, "total_count": None, "elapsed_ms": None,
                "peak_rss_gb": None, "error": None}

    adapted_sql = sql.replace("Comment_replyOf_Message", "Comment_replyOf_Message_u")
    adapted_sql = adapted_sql.replace("Message_hasCreator_Person", "Message_hasCreator_Person_u")

    q: multiprocessing.Queue = multiprocessing.Queue()
    proc = multiprocessing.Process(target=_duckdb_worker,
                                   args=(adapted_sql, duckdb_path, q))

    # Reset RUSAGE_CHILDREN baseline before spawning so we only capture this child
    try:
        resource.getrusage(resource.RUSAGE_CHILDREN)
    except Exception:
        pass

    proc.start()
    peak_rss_poll = 0.0
    poll_interval = 1.0
    OOM_THRESHOLD_GB = 700.0

    while proc.is_alive():
        proc.join(timeout=poll_interval)
        if proc.is_alive():
            crss = _get_rss_gb(proc.pid)
            if crss > peak_rss_poll:
                peak_rss_poll = crss
            if peak_rss_poll >= OOM_THRESHOLD_GB:
                proc.kill()
                proc.join(timeout=5)
                return {
                    "supported": True, "total_count": None, "elapsed_ms": None,
                    "peak_rss_gb": round(peak_rss_poll, 2),
                    "error": f"Out of memory ({round(peak_rss_poll, 1)} GB ≥ {int(OOM_THRESHOLD_GB)} GB)",
                }

    # Also try RUSAGE_CHILDREN for accurate post-exit peak
    try:
        ru = resource.getrusage(resource.RUSAGE_CHILDREN)
        peak_rss_ru = ru.ru_maxrss / (1024 * 1024)  # KB → GB on Linux
    except Exception:
        peak_rss_ru = 0.0

    peak_rss = max(peak_rss_poll, peak_rss_ru)

    result = q.get(block=False) if not q.empty() else {}

    if "error" in result:
        return {
            "supported": True, "total_count": None, "elapsed_ms": None,
            "peak_rss_gb": round(peak_rss, 2) if peak_rss > 0 else None,
            "error": result["error"],
        }

    return {
        "supported": True,
        "total_count": result.get("count"),
        "elapsed_ms": result.get("elapsed_ms"),
        "peak_rss_gb": round(peak_rss, 2) if peak_rss > 0 else None,
        "error": None,
    }
