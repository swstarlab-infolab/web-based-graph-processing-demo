import { useState, useCallback, useEffect, type FC } from 'react';
import { runBenchmark, cancelBenchmark } from '../../utils/api';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Cell,
  LabelList,
  Tooltip as RechartsTip,
  Legend,
} from 'recharts';
import type { QueryResult } from '../../types';

// Matches umbra_runner's OOM_THRESHOLD_GB. A run that reaches it is stopped
// backend-side, so this only colours a run that finished right at the edge.
const OOM_LIMIT_GB = 700;

/* ------------------------------------------------------------------ */
/*  Reference benchmark data (LDBC SNB SF=1, LSQB_sf1S)               */
/* ------------------------------------------------------------------ */

interface RefEntry {
  description: string;
  umbra: number;       // ms
  duckdb: number;      // ms
  duckdbNote?: string; // e.g., "near-timeout"
}

/* ------------------------------------------------------------------ */
/*  Peak memory data (LDBC SNB SF=1, S6–S20)                          */
/*  source: benchmark-results/{engine,umbra,duckdb}_bench_sf1_summary  */
/* ------------------------------------------------------------------ */


// Keyed by preset filename (without .json)
const REFERENCE: Record<string, RefEntry> = {
  'WE-q2-simple': { description: '1-hop KNOWS',        umbra: 7.1,   duckdb: 13     },
  'WE-q3':        { description: '2-hop KNOWS',        umbra: 640.7, duckdb: 1980   },
  'WE-q4':        { description: '3-hop KNOWS',        umbra: 12500, duckdb: 185000, duckdbNote: 'near-timeout' },
  'WE-q5':        { description: '1-2 hop KNOWS',      umbra: 493.5, duckdb: 2170   },
  'WE-q6':        { description: '1-3 hop KNOWS',      umbra: 9170,  duckdb: 49000  },
  'WE-q7':        { description: 'KNOWS+HAS_INTEREST', umbra: 98.3,  duckdb: 560    },
  'CRPQ-q1-WE':   { description: 'CRPQ+WE',            umbra: 670,   duckdb: 2430   },
};

// Engine measured times per query (ms)
const ENGINE_TIMES: Record<string, number> = {
  'WE-q2-simple': 9,
  'WE-q3':        18,
  'WE-q4':        362,
  'WE-q5':        19,
  'WE-q6':        344,
  'WE-q7':        16,
  'CRPQ-q1-WE':   28,
};

/* ------------------------------------------------------------------ */
/*  Equivalent SQL queries for Umbra / DuckDB                         */
/* ------------------------------------------------------------------ */

const SQL_QUERIES: Record<string, string> = {
  // ── S1–S5: RPQ queries ──
  'S1-rpq-reply-tag-chain': `-- S1: RPQ REPLY_OF*/HAS_TAG — reply thread → topic tag
WITH RECURSIVE reply_chain(v1, mid, hop) AS (
    SELECT CommentId, CommentId, 0 FROM Comment
    UNION ALL SELECT PostId, PostId, 0 FROM Post
    UNION
    SELECT rc.v1, rom.MessageId, rc.hop + 1
    FROM reply_chain rc
    JOIN Comment_replyOf_Message rom ON rc.mid = rom.CommentId
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT rc.v1, mht.TagId AS v2
    FROM reply_chain rc JOIN Message_hasTag_Tag mht ON rc.mid = mht.MessageId
    UNION SELECT DISTINCT ForumId, TagId FROM Forum_hasTag_Tag
) t`,

  'S2-rpq-liked-reply-chain': `-- S2: RPQ LIKES?/REPLY_OF* — engagement depth from a like
WITH RECURSIVE reply_star(src, dst, hop) AS (
    SELECT CommentId, CommentId, 0 FROM Comment
    UNION ALL SELECT PostId, PostId, 0 FROM Post
    UNION
    SELECT rs.src, rom.MessageId, rs.hop + 1
    FROM reply_star rs JOIN Comment_replyOf_Message rom ON rs.dst = rom.CommentId
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT PersonId AS v1, PersonId AS v2 FROM Person
    UNION SELECT CommentId, CommentId FROM Comment
    UNION SELECT PostId, PostId FROM Post
    UNION SELECT ForumId, ForumId FROM Forum
    UNION SELECT TagId, TagId FROM Tag
    UNION SELECT TagClassId, TagClassId FROM TagClass
    UNION SELECT DISTINCT plc.PersonId, rs.dst FROM Person_likes_Comment plc
          JOIN reply_star rs ON plc.CommentId = rs.src
    UNION SELECT DISTINCT plp.PersonId, rs.dst FROM Person_likes_Post plp
          JOIN reply_star rs ON plp.PostId = rs.src
    UNION SELECT DISTINCT rom.CommentId, rs.dst FROM Comment_replyOf_Message rom
          JOIN reply_star rs ON rom.MessageId = rs.src
) t`,

  'S3-rpq-mixed-reach': `-- S3: RPQ (REPLY_OF|HAS_TAG)* — mixed topic cluster reach
WITH RECURSIVE mixed_edge(src, dst) AS (
    SELECT CommentId, MessageId FROM Comment_replyOf_Message
    UNION ALL SELECT MessageId, TagId FROM Message_hasTag_Tag
    UNION ALL SELECT ForumId, TagId FROM Forum_hasTag_Tag
),
mixed_reach(v1, mid) AS (
    SELECT CommentId, CommentId FROM Comment
    UNION ALL SELECT PostId, PostId FROM Post
    UNION ALL SELECT ForumId, ForumId FROM Forum
    UNION
    SELECT mr.v1, me.dst FROM mixed_reach mr JOIN mixed_edge me ON mr.mid = me.src
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT PersonId AS v1, PersonId AS v2 FROM Person
    UNION SELECT CommentId, CommentId FROM Comment
    UNION SELECT PostId, PostId FROM Post
    UNION SELECT ForumId, ForumId FROM Forum
    UNION SELECT TagId, TagId FROM Tag
    UNION SELECT TagClassId, TagClassId FROM TagClass
    UNION SELECT DISTINCT v1, mid AS v2 FROM mixed_reach
) t`,

  'S4-rpq-friend-liked-content': `-- S4: RPQ KNOWS*/LIKES* — friends' liked content
WITH RECURSIVE knows_star(src, dst, hop) AS (
    SELECT PersonId, PersonId, 0 FROM Person
    UNION
    SELECT ks.src, pkp.Person2Id, ks.hop + 1
    FROM knows_star ks JOIN Person_knows_Person pkp ON ks.dst = pkp.Person1Id
    WHERE ks.hop < 20
),
kd AS (SELECT DISTINCT src, dst FROM knows_star)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT PersonId AS v1, PersonId AS v2 FROM Person
    UNION SELECT CommentId, CommentId FROM Comment
    UNION SELECT PostId, PostId FROM Post
    UNION SELECT ForumId, ForumId FROM Forum
    UNION SELECT TagId, TagId FROM Tag
    UNION SELECT TagClassId, TagClassId FROM TagClass
    UNION SELECT DISTINCT src, dst FROM kd
    UNION SELECT DISTINCT kd.src, plc.CommentId FROM kd
          JOIN Person_likes_Comment plc ON kd.dst = plc.PersonId
    UNION SELECT DISTINCT kd.src, plp.PostId FROM kd
          JOIN Person_likes_Post plp ON kd.dst = plp.PersonId
) t`,

  'S5-rpq-creator-social': `-- S5: RPQ (HAS_MEMBER|HAS_MODERATOR)/KNOWS* — forum member social reach
WITH RECURSIVE knows_reach(v1, dst, hop) AS (
    SELECT f.ForumId, f.hasModerator_PersonId, 0
    FROM Forum f WHERE f.hasModerator_PersonId IS NOT NULL
    UNION
    SELECT kr.v1, pkp.Person2Id, kr.hop + 1
    FROM knows_reach kr JOIN Person_knows_Person pkp ON kr.dst = pkp.Person1Id
    WHERE kr.hop < 20
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT v1, dst AS v2 FROM knows_reach
) t`,

  // ── S6–S10: Word Equality queries ──
  'S6-we-friend-equality': `-- S6: WE KNOWS*=KNOWS* (same source) — symmetric social reach
WITH RECURSIVE KnowsHops(src, dest, hop) AS (
    SELECT PersonId, PersonId, 0 FROM Person
    UNION
    SELECT k.src, p.Person2Id, k.hop + 1
    FROM KnowsHops k JOIN Person_knows_Person p ON k.dest = p.Person1Id
    WHERE k.hop < 20
)
SELECT SUM(CAST(cnt AS BIGINT) * cnt) AS total_count
FROM (
    SELECT src, hop, COUNT(DISTINCT dest) AS cnt
    FROM KnowsHops GROUP BY src, hop
) t`,

  'S7-we-reply-tag-equality': `-- S7: WE REPLY_OF*/HAS_TAG = REPLY_OF*/HAS_TAG (same source)
WITH RECURSIVE reply_chain(src, mid, depth) AS (
    SELECT CommentId, CommentId, 0 FROM Comment
    UNION ALL SELECT PostId, PostId, 0 FROM Post
    UNION
    SELECT rc.src, rom.MessageId, rc.depth + 1
    FROM reply_chain rc JOIN Comment_replyOf_Message rom ON rc.mid = rom.CommentId
),
tag_reach AS (
    SELECT DISTINCT rc.src, rc.depth, mht.TagId
    FROM reply_chain rc JOIN Message_hasTag_Tag mht ON rc.mid = mht.MessageId
    UNION ALL
    SELECT DISTINCT fht.ForumId AS src, 0 AS depth, fht.TagId FROM Forum_hasTag_Tag fht
),
cnt AS (SELECT src, depth, COUNT(*) AS c FROM tag_reach GROUP BY src, depth)
SELECT CAST(SUM(CAST(c AS BIGINT) * c) AS BIGINT) AS total_count FROM cnt`,

  'S8-we-diff-reply-tag': `-- S8: WE REPLY_OF*/HAS_TAG ≠ (REPLY_OF|HAS_TAG)* — regex intersection = S7
-- L(P1) ∩ L(P2) = L(P1), so result equals S7
WITH RECURSIVE reply_chain(src, mid, depth) AS (
    SELECT CommentId, CommentId, 0 FROM Comment
    UNION ALL SELECT PostId, PostId, 0 FROM Post
    UNION
    SELECT rc.src, rom.MessageId, rc.depth + 1
    FROM reply_chain rc JOIN Comment_replyOf_Message rom ON rc.mid = rom.CommentId
),
tag_reach AS (
    SELECT DISTINCT rc.src, rc.depth, mht.TagId
    FROM reply_chain rc JOIN Message_hasTag_Tag mht ON rc.mid = mht.MessageId
    UNION ALL
    SELECT DISTINCT fht.ForumId AS src, 0 AS depth, fht.TagId FROM Forum_hasTag_Tag fht
),
cnt AS (SELECT src, depth, COUNT(*) AS c FROM tag_reach GROUP BY src, depth)
SELECT CAST(SUM(CAST(c AS BIGINT) * c) AS BIGINT) AS total_count FROM cnt`,

  'S9-we-diff-friend-interest': `-- S9: WE KNOWS*/(LIKES|HAS_INTEREST) ≠ KNOWS*/LIKES*/HAS_INTEREST? (same source)
WITH RECURSIVE knows_reach(src, mid, hop) AS (
    SELECT PersonId, PersonId, 0 FROM Person
    UNION
    SELECT kr.src, pkp.Person2Id, kr.hop + 1
    FROM knows_reach kr JOIN Person_knows_Person pkp ON kr.mid = pkp.Person1Id
    WHERE kr.hop < 20
),
kd AS (SELECT DISTINCT src, mid, hop FROM knows_reach),
likes_cnt AS (
    SELECT kd.src, kd.hop, COUNT(DISTINCT l.msg) AS c FROM kd
    JOIN (SELECT PersonId AS pid, CommentId AS msg FROM Person_likes_Comment
          UNION ALL SELECT PersonId, PostId FROM Person_likes_Post) l ON kd.mid = l.pid
    GROUP BY kd.src, kd.hop
),
hi_cnt AS (
    SELECT kd.src, kd.hop, COUNT(DISTINCT phi.TagId) AS c FROM kd
    JOIN Person_hasInterest_Tag phi ON kd.mid = phi.PersonId
    GROUP BY kd.src, kd.hop
)
SELECT CAST(
    COALESCE((SELECT SUM(CAST(c AS BIGINT) * c) FROM likes_cnt), 0) +
    COALESCE((SELECT SUM(CAST(c AS BIGINT) * c) FROM hi_cnt), 0)
AS BIGINT) AS total_count`,

  'S10-we-diff-source-friend': `-- S10: WE diff-source P1=KNOWS*/HAS_INTEREST/HAS_TYPE vs P2=(KNOWS|HAS_INTEREST)*/HAS_TYPE (KNOWS link)
-- L(P1)∩L(P2) = KNOWS^n·HAS_INTEREST·HAS_TYPE (n≥0) — both paths reduce to same structure.
-- WARNING: full KNOWS* transitive closure → T.O./OOM on sf≥1 for Umbra/DuckDB.
WITH RECURSIVE knows_reach(src, mid, depth) AS (
    SELECT PersonId, PersonId, 0 FROM Person
    UNION
    SELECT kr.src, pkp.Person2Id, kr.depth + 1
    FROM knows_reach kr
    JOIN Person_knows_Person pkp ON kr.mid = pkp.Person1Id
),
paths AS (
    SELECT kr.src, tht.TagClassId, kr.depth + 2 AS total_depth
    FROM knows_reach kr
    JOIN Person_hasInterest_Tag pit ON kr.mid = pit.PersonId
    JOIN Tag_hasType_TagClass tht ON pit.TagId = tht.TagId
),
cnt AS (
    SELECT src, total_depth, COUNT(DISTINCT TagClassId) AS c
    FROM paths
    GROUP BY src, total_depth
)
SELECT CAST(SUM(CAST(c1.c AS BIGINT) * CAST(c2.c AS BIGINT)) AS BIGINT) AS total_count
FROM Person_knows_Person pkp
JOIN cnt c1 ON pkp.Person1Id = c1.src
JOIN cnt c2 ON pkp.Person2Id = c2.src AND c1.total_depth = c2.total_depth`,

  // ── S11–S14: Prefix Word Equality ──
  'S11-prefix-friend-chain': `-- S11: Prefix WE KNOWS* ≺ KNOWS*, continuation KNOWS*
WITH RECURSIVE knows_reach(src, dst, hop) AS (
    SELECT PersonId, PersonId, 0 FROM Person
    UNION
    SELECT kr.src, pkp.Person2Id, kr.hop + 1
    FROM knows_reach kr JOIN Person_knows_Person pkp ON kr.dst = pkp.Person1Id
    WHERE kr.hop < 20
),
kd AS (SELECT DISTINCT src, dst, hop FROM knows_reach),
first_hop AS (SELECT src, dst, MIN(hop) AS min_hop FROM kd GROUP BY src, dst),
first_cnt AS (SELECT src, min_hop, COUNT(*) AS fc FROM first_hop GROUP BY src, min_hop),
suffix_distinct AS (
    SELECT src, min_hop AS k,
        SUM(fc) OVER (PARTITION BY src ORDER BY min_hop ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS sdist
    FROM first_cnt
),
total_reach AS (SELECT src, COUNT(DISTINCT dst) AS total_c FROM kd GROUP BY src)
SELECT CAST(SUM(CAST(sd.sdist AS BIGINT) * CAST(tr.total_c AS BIGINT)) AS BIGINT) AS total_count
FROM first_hop fh
JOIN suffix_distinct sd ON fh.src = sd.src AND fh.min_hop = sd.k
JOIN total_reach tr ON fh.dst = tr.src`,

  'S12-prefix-mixed-friend': `-- S12: Prefix WE KNOWS* ≺ (KNOWS|HAS_INTEREST)*, continuation HAS_INTEREST
WITH RECURSIVE knows_reach(src, dst, hop) AS (
    SELECT PersonId, PersonId, 0 FROM Person
    UNION
    SELECT kr.src, pkp.Person2Id, kr.hop + 1
    FROM knows_reach kr JOIN Person_knows_Person pkp ON kr.dst = pkp.Person1Id
    WHERE kr.hop < 20
),
kd AS (SELECT DISTINCT src, dst, hop FROM knows_reach),
mixed_edges(src, dst) AS (
    SELECT Person1Id, Person2Id FROM Person_knows_Person
    UNION ALL SELECT PersonId, TagId FROM Person_hasInterest_Tag
),
mixed_reach(person_src, dst) AS (
    SELECT PersonId, PersonId FROM Person
    UNION SELECT mr.person_src, me.dst FROM mixed_reach mr JOIN mixed_edges me ON mr.dst = me.src
),
mixed_cnt AS (SELECT person_src, COUNT(DISTINCT dst) AS mcnt FROM mixed_reach GROUP BY person_src),
hi_deg AS (SELECT PersonId AS pid, COUNT(*) AS deg FROM Person_hasInterest_Tag GROUP BY PersonId),
first_hop AS (SELECT src, dst, MIN(hop) AS min_hop FROM kd GROUP BY src, dst),
p2_suffix AS (
    SELECT fh.src, fh.min_hop AS k, SUM(mc.mcnt) AS p2_cnt
    FROM first_hop fh JOIN mixed_cnt mc ON fh.dst = mc.person_src GROUP BY fh.src, fh.min_hop
),
p2_suffix_cum AS (
    SELECT src, k,
        SUM(p2_cnt) OVER (PARTITION BY src ORDER BY k ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS suffix_p2
    FROM p2_suffix
)
SELECT CAST(SUM(CAST(ps.suffix_p2 AS BIGINT) * CAST(COALESCE(hd.deg, 0) AS BIGINT)) AS BIGINT) AS total_count
FROM first_hop fh JOIN p2_suffix_cum ps ON fh.src = ps.src AND fh.min_hop = ps.k
LEFT JOIN hi_deg hd ON fh.dst = hd.pid WHERE hd.deg IS NOT NULL`,

  'S13-prefix-like-reply': `-- S13: Prefix WE LIKES/REPLY_OF* ≺ LIKES/REPLY_OF*, continuation HAS_TAG
WITH RECURSIVE lr(src, dst, depth) AS (
    SELECT PersonId, CommentId, 1 FROM Person_likes_Comment
    UNION ALL SELECT PersonId, PostId, 1 FROM Person_likes_Post
    UNION
    SELECT lr.src, rom.MessageId, lr.depth + 1
    FROM lr JOIN Comment_replyOf_Message rom ON lr.dst = rom.CommentId
),
lr_dedup AS (SELECT DISTINCT src, dst, depth FROM lr),
first_depth AS (SELECT src, dst, MIN(depth) AS min_d FROM lr_dedup GROUP BY src, dst),
first_cnt AS (SELECT src, min_d, COUNT(*) AS fc FROM first_depth GROUP BY src, min_d),
suffix_distinct AS (
    SELECT src, min_d AS k,
        SUM(fc) OVER (PARTITION BY src ORDER BY min_d ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS sdist
    FROM first_cnt
),
tag_deg AS (SELECT MessageId AS mid, COUNT(*) AS tdeg FROM Message_hasTag_Tag GROUP BY MessageId)
SELECT CAST(SUM(CAST(sd.sdist AS BIGINT) * CAST(td.tdeg AS BIGINT)) AS BIGINT) AS total_count
FROM first_depth fd
JOIN suffix_distinct sd ON fd.src = sd.src AND fd.min_d = sd.k
JOIN tag_deg td ON fd.dst = td.mid`,

  'S14-prefix-mixed-chain': `-- S14: Prefix WE (KNOWS|HI) ≺ (KNOWS|HI)*, continuation (KNOWS|HI)
WITH RECURSIVE mixed_edges(src, dst) AS (
    SELECT Person1Id, Person2Id FROM Person_knows_Person
    UNION ALL SELECT PersonId, TagId FROM Person_hasInterest_Tag
),
mixed_reach(person_src, dst) AS (
    SELECT PersonId, PersonId FROM Person
    UNION
    SELECT mr.person_src, me.dst FROM mixed_reach mr JOIN mixed_edges me ON mr.dst = me.src
),
mixed_cnt AS (SELECT person_src, COUNT(DISTINCT dst) AS mcnt FROM mixed_reach GROUP BY person_src),
knows_deg AS (SELECT Person1Id AS pid, COUNT(*) AS kdeg FROM Person_knows_Person GROUP BY Person1Id),
hi_deg AS (SELECT PersonId AS pid, COUNT(*) AS hdeg FROM Person_hasInterest_Tag GROUP BY PersonId),
p2_via_knows AS (
    SELECT k.Person1Id AS v1, SUM(mc.mcnt) AS p2_cnt
    FROM Person_knows_Person k JOIN mixed_cnt mc ON k.Person2Id = mc.person_src GROUP BY k.Person1Id
)
SELECT CAST(SUM(
    CAST(p2.p2_cnt AS BIGINT) * (COALESCE(kd.kdeg, 0) + COALESCE(hd.hdeg, 0))
) AS BIGINT) AS total_count
FROM Person_knows_Person pk JOIN p2_via_knows p2 ON pk.Person1Id = p2.v1
LEFT JOIN knows_deg kd ON pk.Person2Id = kd.pid
LEFT JOIN hi_deg hd ON pk.Person2Id = hd.pid
WHERE COALESCE(kd.kdeg, 0) + COALESCE(hd.hdeg, 0) > 0`,

  // ── S15–S17: CRPQ + Length ──
  'S15-crpq-length-friend-triangle': `-- S15: CRPQ — comment→post, creators linked by KNOWS{1,3}
WITH
knows_hop1 AS (SELECT DISTINCT Person1Id AS src, Person2Id AS dst FROM Person_knows_Person),
knows_hop2 AS (
    SELECT DISTINCT k1.Person1Id AS src, k2.Person2Id AS dst
    FROM Person_knows_Person k1 JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
),
knows_hop3 AS (
    SELECT DISTINCT k1.Person1Id AS src, k3.Person2Id AS dst
    FROM Person_knows_Person k1 JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
    JOIN Person_knows_Person k3 ON k2.Person2Id = k3.Person1Id
),
knows_reach AS (
    SELECT src, dst FROM knows_hop1 UNION SELECT src, dst FROM knows_hop2 UNION SELECT src, dst FROM knows_hop3
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT rom.CommentId, p.PostId, mc.PersonId AS person1, mp.PersonId AS person2
    FROM Comment_replyOf_Message rom
    JOIN Post p ON rom.MessageId = p.PostId
    JOIN Message_hasCreator_Person mc ON rom.CommentId = mc.MessageId
    JOIN Message_hasCreator_Person mp ON p.PostId = mp.MessageId
    JOIN knows_reach kr ON mc.PersonId = kr.src AND mp.PersonId = kr.dst
) t`,

  'S16-crpq-length-friend-interest': `-- S16: CRPQ — comment→(REPLY_OF{1,3}/HAS_TAG)→tag, person→HAS_INTEREST→tag
WITH
knows_hop2 AS (
    SELECT DISTINCT k1.Person1Id AS src, k2.Person2Id AS dst
    FROM Person_knows_Person k1 JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
),
knows_hop3 AS (
    SELECT DISTINCT k1.Person1Id AS src, k3.Person2Id AS dst
    FROM Person_knows_Person k1 JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
    JOIN Person_knows_Person k3 ON k2.Person2Id = k3.Person1Id
),
knows_hop4 AS (
    SELECT DISTINCT k1.Person1Id AS src, k4.Person2Id AS dst
    FROM Person_knows_Person k1 JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
    JOIN Person_knows_Person k3 ON k2.Person2Id = k3.Person1Id
    JOIN Person_knows_Person k4 ON k3.Person2Id = k4.Person1Id
),
knows_reach AS (
    SELECT src, dst FROM knows_hop2 UNION SELECT src, dst FROM knows_hop3 UNION SELECT src, dst FROM knows_hop4
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT fhm.ForumId, fhm.PersonId AS person1, kr.dst AS person2, phi.TagId
    FROM Forum_hasMember_Person fhm
    JOIN knows_reach kr ON fhm.PersonId = kr.src
    JOIN Person_hasInterest_Tag phi ON kr.dst = phi.PersonId
    WHERE fhm.PersonId <> kr.dst
) t`,

  'S17-crpq-length-dual-bounded': `-- S17: CRPQ — dual bounded: comment→REPLY_OF{1,3}→post, creators KNOWS{1,2}
WITH RECURSIVE reply_chain(cid, mid, hop) AS (
    SELECT CommentId, MessageId, 1 FROM Comment_replyOf_Message
    UNION
    SELECT rc.cid, rom.MessageId, rc.hop + 1
    FROM reply_chain rc JOIN Comment_replyOf_Message rom ON rc.mid = rom.CommentId
    WHERE rc.hop < 3
),
comment_to_post AS (SELECT DISTINCT rc.cid, p.PostId AS pid FROM reply_chain rc JOIN Post p ON rc.mid = p.PostId),
knows_hop1 AS (SELECT DISTINCT Person1Id AS src, Person2Id AS dst FROM Person_knows_Person),
knows_hop2 AS (
    SELECT DISTINCT k1.Person1Id AS src, k2.Person2Id AS dst
    FROM Person_knows_Person k1 JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
),
knows_reach AS (SELECT src, dst FROM knows_hop1 UNION SELECT src, dst FROM knows_hop2)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT ctp.cid, ctp.pid, mc.PersonId AS person1, mp.PersonId AS person2
    FROM comment_to_post ctp
    JOIN Message_hasCreator_Person mc ON ctp.cid = mc.MessageId
    JOIN Message_hasCreator_Person mp ON ctp.pid = mp.MessageId
    JOIN knows_reach kr ON mc.PersonId = kr.src AND mp.PersonId = kr.dst
) t`,

  // ── S18–S19: RPQ + Length ──
  'S18-rpq-length-friend-liked': `-- S18: RPQ KNOWS{1,3}/LIKES* — bounded friends' liked content
WITH
knows_hop1 AS (SELECT DISTINCT Person1Id AS src, Person2Id AS dst FROM Person_knows_Person),
knows_hop2 AS (
    SELECT DISTINCT k1.Person1Id AS src, k2.Person2Id AS dst
    FROM Person_knows_Person k1 JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
),
knows_hop3 AS (
    SELECT DISTINCT k1.Person1Id AS src, k3.Person2Id AS dst
    FROM Person_knows_Person k1 JOIN Person_knows_Person k2 ON k1.Person2Id = k2.Person1Id
    JOIN Person_knows_Person k3 ON k2.Person2Id = k3.Person1Id
),
knows_reach AS (
    SELECT src, dst FROM knows_hop1 UNION SELECT src, dst FROM knows_hop2 UNION SELECT src, dst FROM knows_hop3
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT src AS v1, dst AS v2 FROM knows_reach
    UNION SELECT DISTINCT kr.src, plc.CommentId FROM knows_reach kr JOIN Person_likes_Comment plc ON kr.dst = plc.PersonId
    UNION SELECT DISTINCT kr.src, plp.PostId   FROM knows_reach kr JOIN Person_likes_Post plp    ON kr.dst = plp.PersonId
) t`,

  'S19-rpq-length-reply-tag': `-- S19: RPQ REPLY_OF{0,2}/HAS_TAG — bounded reply chain → tag
WITH RECURSIVE reply_chain(v1, mid, hop) AS (
    SELECT CommentId, CommentId, 0 FROM Comment
    UNION ALL SELECT PostId, PostId, 0 FROM Post
    UNION
    SELECT rc.v1, rom.MessageId, rc.hop + 1
    FROM reply_chain rc JOIN Comment_replyOf_Message rom ON rc.mid = rom.CommentId
    WHERE rc.hop < 2
)
SELECT CAST(COUNT(*) AS BIGINT) FROM (
    SELECT DISTINCT rc.v1, mht.TagId AS v2
    FROM reply_chain rc JOIN Message_hasTag_Tag mht ON rc.mid = mht.MessageId
    UNION SELECT DISTINCT ForumId, TagId FROM Forum_hasTag_Tag
) t`,

  // ── Legacy queries ──
  'WE-q2-simple': `SELECT SUM(CAST(cnt AS BIGINT) * cnt) AS total_count
FROM (SELECT Person1Id, COUNT(*) AS cnt FROM Person_knows_Person GROUP BY Person1Id) t`,

  'WE-q3': `WITH hop2 AS (
  SELECT k1.PersonId1 AS src, k2.PersonId2 AS dst
  FROM Person_knows_Person k1 JOIN Person_knows_Person k2 ON k1.PersonId2 = k2.PersonId1
)
SELECT COUNT(*) FROM (SELECT a.dst, b.dst FROM hop2 a JOIN hop2 b ON a.src = b.src AND a.dst < b.dst) t`,

  'CRPQ-q1-WE': `WITH RECURSIVE knows_star AS (
  SELECT PersonId1 AS src, PersonId2 AS dst FROM Person_knows_Person
  UNION ALL SELECT ks.src, k.PersonId2 FROM knows_star ks JOIN Person_knows_Person k ON ks.dst = k.PersonId1
)
SELECT COUNT(*) FROM knows_star ks
JOIN Post_hasCreator_Person phc ON ks.dst = phc.PersonId
JOIN Comment_replyOf_Post crp ON crp.PostId = phc.PostId
JOIN Comment_hasCreator_Person chc ON crp.CommentId = chc.CommentId
WHERE ks.src = chc.PersonId`,
};

const SHORT_NAMES: Record<string, string> = {
  'S10-we-diff-source-friend': 'S10-WE',
  'WE-q2-simple': 'WE-q2',
  'WE-q3':        'WE-q3',
  'WE-q4':        'WE-q4',
  'WE-q5':        'WE-q5',
  'WE-q6':        'WE-q6',
  'WE-q7':        'WE-q7',
  'CRPQ-q1-WE':   'CRPQ-WE',
};

const OVERVIEW_DATA = Object.keys(REFERENCE).map((k) => ({
  name: SHORT_NAMES[k] ?? k,
  fullName: k,
  engine: ENGINE_TIMES[k],
  umbra:  REFERENCE[k].umbra,
  duckdb: REFERENCE[k].duckdb,
  description: REFERENCE[k].description,
  duckdbNote: REFERENCE[k].duckdbNote,
}));

interface PresetMeta { shortId: string; constraint: string; color: string }

function parsePresetMeta(stem: string): PresetMeta {
  // S-series: S10-we-diff-source-friend
  const sMatch = stem.match(/^(S\d+)-(.*)/i);
  if (sMatch) {
    const id = sMatch[1].toUpperCase();
    const rest = sMatch[2].toLowerCase();
    if (rest.includes('crpq') && rest.includes('length'))   return { shortId: id, constraint: 'Bounded Length', color: '#fb923c' };
    if (rest.includes('crpq'))                              return { shortId: id, constraint: 'CRPQ',           color: '#a78bfa' };
    if (rest.includes('prefix'))                            return { shortId: id, constraint: 'Prefix',         color: '#34d399' };
    if (rest.includes('diff'))                              return { shortId: id, constraint: 'Word Equality',        color: '#818cf8' };
    if (rest.includes('we'))                                return { shortId: id, constraint: 'Word Equality',  color: '#818cf8' };
    if (rest.includes('length'))                            return { shortId: id, constraint: 'Bounded Length', color: '#fb923c' };
    return { shortId: id, constraint: 'RPQ', color: '#22d3ee' };
  }
  // WE-q* / CRPQ-q1-WE series
  if (stem.toUpperCase().includes('CRPQ') && stem.toUpperCase().includes('WE'))
    return { shortId: stem, constraint: 'Word Equality', color: '#818cf8' };
  if (stem.toUpperCase().startsWith('WE'))
    return { shortId: stem, constraint: 'Word Equality', color: '#818cf8' };
  return { shortId: stem, constraint: 'RPQ', color: '#22d3ee' };
}

function lookupRef(filename: string | null | undefined): RefEntry | null {
  if (!filename) return null;
  // strip .json extension
  const key = filename.replace(/\.json$/, '');
  return REFERENCE[key] ?? null;
}

function fmtGb(gb: number): string {
  if (gb < 0.1) return `<0.1 GB`;
  if (gb >= 100) return `${gb.toFixed(0)} GB`;
  if (gb >= 10) return `${gb.toFixed(1)} GB`;
  return `${gb.toFixed(2)} GB`;
}

function fmtMs(ms: number): string {
  if (ms >= 60000) return `${(ms / 60000).toFixed(2)}m`;
  if (ms < 0.1)    return `<0.001s`;
  return `${(ms / 1000).toFixed(3)}s`;
}

function speedupLabel(ratio: number): string {
  if (ratio >= 1000) return `${(ratio / 1000).toFixed(1)}k×`;
  if (ratio >= 10)   return `${Math.round(ratio)}×`;
  return `${ratio.toFixed(1)}×`;
}

function speedupBadgeColor(ratio: number, isDark: boolean): { bg: string; text: string } {
  if (ratio >= 100) return { bg: isDark ? '#78350f33' : '#fef3c7', text: isDark ? '#fcd34d' : '#d97706' };
  if (ratio >= 10)  return { bg: isDark ? '#164e6333' : '#ecfeff', text: isDark ? '#22d3ee' : '#0891b2' };
  return              { bg: isDark ? '#05281133' : '#d1fae5', text: isDark ? '#34d399' : '#059669' };
}

function isTimeoutError(err: string | null): boolean {
  if (!err) return false;
  return /timed?\s*out|timeout/i.test(err);
}

function isOOMError(err: string | null): boolean {
  if (!err) return false;
  return /out\s*of\s*memory|oom|memory.*exhaust|cannot\s*allocate|alloc.*fail/i.test(err);
}

function errorKind(err: string | null): 'timeout' | 'oom' | 'error' | null {
  if (!err) return null;
  if (isTimeoutError(err)) return 'timeout';
  if (isOOMError(err)) return 'oom';
  return 'error';
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface BenchmarkPanelProps {
  isDark?: boolean;
  result: QueryResult | null;
  presetFilename?: string | null;
  datasetId?: string;
}

const BenchmarkPanel: FC<BenchmarkPanelProps> = ({ isDark = true, result, presetFilename, datasetId }) => {
  const d = isDark;

  // No result yet → show empty state (no pre-stored data should be visible)
  if (!result) {
    return (
      <div className={`h-full flex flex-col items-center justify-center gap-3 ${d ? 'bg-gray-900' : 'bg-white'}`}>
        <svg className={`w-12 h-12 ${d ? 'text-gray-700' : 'text-gray-300'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
        <p className={`text-sm ${d ? 'text-gray-500' : 'text-gray-400'}`}>Run a query to see benchmark comparison</p>
      </div>
    );
  }

  const ref = lookupRef(presetFilename);
  const [logScale, setLogScale] = useState(true);
  const [showSQL, setShowSQL] = useState(false);
  const [sqlKey, setSqlKey] = useState<string | null>(null);
  const [copiedSQL, setCopiedSQL] = useState(false);

  // ── Live state for full comparison view (result && ref) ──
  const [umbraLive, setUmbraLive] = useState<{ ms: number; count: number; rss?: number } | null>(null);
  const [duckdbLive, setDuckdbLive] = useState<{ ms: number; count: number; rss?: number } | null>(null);
  const [umbraError, setUmbraError] = useState<string | null>(null);
  const [duckdbError, setDuckdbError] = useState<string | null>(null);
  const [runningSystem, setRunningSystem] = useState<'umbra' | 'duckdb' | null>(null);
  const [timeoutSec, setTimeoutSec] = useState(150);
  const [editingTimeout, setEditingTimeout] = useState(false);
  const [timeoutInput, setTimeoutInput] = useState('150');
  const [isCancelling, setIsCancelling] = useState(false);

  useEffect(() => {
    setUmbraLive(null);
    setDuckdbLive(null);
    setUmbraError(null);
    setDuckdbError(null);
  }, [presetFilename]);

  const handleRun = useCallback(async (system: 'umbra' | 'duckdb') => {
    if (!presetFilename || runningSystem !== null) return;
    setRunningSystem(system);
    setIsCancelling(false);
    if (system === 'umbra') setUmbraError(null);
    else setDuckdbError(null);
    try {
      const res = await runBenchmark(presetFilename, system, timeoutSec, datasetId);
      if (!res.supported) {
        const msg = `No SQL mapping for ${presetFilename}`;
        if (system === 'umbra') setUmbraError(msg);
        else setDuckdbError(msg);
      } else if (res.error) {
        if (system === 'umbra') setUmbraError(res.error);
        else setDuckdbError(res.error);
      } else if (res.elapsed_ms !== null && res.total_count !== null) {
        const live = { ms: res.elapsed_ms, count: res.total_count, rss: res.peak_rss_gb ?? undefined };
        if (system === 'umbra') setUmbraLive(live);
        else setDuckdbLive(live);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      if (system === 'umbra') setUmbraError(msg);
      else setDuckdbError(msg);
    } finally {
      setRunningSystem(null);
      setIsCancelling(false);
    }
  }, [presetFilename, runningSystem, timeoutSec]);

  const handleStop = useCallback(async () => {
    if (!runningSystem || isCancelling) return;
    setIsCancelling(true);
    await cancelBenchmark();
  }, [runningSystem, isCancelling]);

  // Stem key for lookups (e.g. "WE-q2-simple")
  const stem = presetFilename?.replace(/\.json$/, '') ?? null;
  const presetMeta = stem ? parsePresetMeta(stem) : null;

  // Engine time: actual run only
  const engineMs        = result?.elapsed_ms ?? null;
  const engineIsActual  = engineMs !== null;

  const currentSqlKey = sqlKey ?? stem;
  const currentSQL = currentSqlKey ? SQL_QUERIES[currentSqlKey] : null;

  const handleCopySQL = useCallback(() => {
    if (!currentSQL) return;
    navigator.clipboard.writeText(currentSQL).then(() => {
      setCopiedSQL(true);
      setTimeout(() => setCopiedSQL(false), 1500);
    });
  }, [currentSQL]);

  // ---- No preset selected: show overview chart (read-only) ----
  if (!presetFilename) {
    const tickVals = [1, 10, 100, 1000, 10000, 100000];
    return (
      <div className={`h-full flex flex-col overflow-hidden ${d ? 'bg-gray-900' : 'bg-white'}`}>
        {/* Header */}
        <div className={`px-5 pt-3 pb-2 shrink-0 border-b flex items-center justify-between ${d ? 'border-gray-700/80' : 'border-gray-200'}`}>
          <div>
            <h3 className={`text-sm font-bold ${d ? 'text-gray-100' : 'text-gray-900'}`}>
              Performance comparisons
            </h3>
            <p className={`text-[15px] mt-0.5 ${d ? 'text-gray-500' : 'text-gray-400'}`}>
              Extended CRPQs execute efficiently on the GPU · LDBC SNB SF=1
            </p>
          </div>
          <div className="flex items-center gap-2">
            {(
              <button
                className={`text-[14px] px-2 py-1 rounded border transition-colors ${
                  showSQL
                    ? d ? 'bg-violet-900/30 border-violet-700/60 text-violet-300' : 'bg-violet-50 border-violet-300 text-violet-600'
                    : d ? 'bg-gray-800 border-gray-600 text-gray-400' : 'bg-white border-gray-300 text-gray-500'
                }`}
                onClick={() => setShowSQL(v => !v)}
              >
                SQL
              </button>
            )}
            <button
              className={`text-[14px] px-2 py-1 rounded border transition-colors ${
                logScale
                  ? d ? 'bg-cyan-900/30 border-cyan-700/60 text-cyan-300' : 'bg-cyan-50 border-cyan-300 text-cyan-600'
                  : d ? 'bg-gray-800 border-gray-600 text-gray-400' : 'bg-white border-gray-300 text-gray-500'
              }`}
              onClick={() => setLogScale(v => !v)}
            >
              {logScale ? 'Log' : 'Linear'}
            </button>
          </div>
        </div>

        {/* SQL panel — only in time view */}
        {showSQL && (
          <div className={`shrink-0 border-b ${d ? 'border-gray-700/80 bg-gray-950' : 'border-gray-200 bg-gray-50'}`}>
            <div className={`flex items-center gap-1.5 px-3 pt-2 pb-1 flex-wrap`}>
              {Object.keys(SQL_QUERIES).map((k) => (
                <button key={k}
                  className={`text-[15px] px-2 py-0.5 rounded border transition-colors ${
                    currentSqlKey === k
                      ? d ? 'bg-violet-900/40 border-violet-600/60 text-violet-300' : 'bg-violet-100 border-violet-300 text-violet-700'
                      : d ? 'border-gray-700 text-gray-500 hover:text-gray-300' : 'border-gray-200 text-gray-400 hover:text-gray-600'
                  }`}
                  onClick={() => setSqlKey(k)}
                >
                  {SHORT_NAMES[k] ?? k}
                </button>
              ))}
              <button
                className={`text-[15px] px-2 py-0.5 rounded ml-auto transition-colors ${copiedSQL ? (d ? 'text-emerald-400' : 'text-emerald-600') : (d ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600')}`}
                onClick={handleCopySQL} disabled={!currentSQL}
              >
                {copiedSQL ? '✓ Copied' : 'Copy'}
              </button>
            </div>
            <pre className={`text-[14px] leading-5 px-3 pb-2 overflow-x-auto font-mono max-h-40 ${d ? 'text-gray-300' : 'text-gray-700'}`} style={{ scrollbarWidth: 'thin' }}>
              {currentSQL ?? `-- No SQL available for "${currentSqlKey}"`}
            </pre>
          </div>
        )}

        {/* Chart */}
        <div className="flex-1 min-h-0 px-2 py-3">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={OVERVIEW_DATA} margin={{ top: 8, right: 16, bottom: 4, left: 16 }} barCategoryGap="25%">
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={d ? '#1f2937' : '#e5e7eb'} />
                <XAxis dataKey="name" tick={{ fill: d ? '#9ca3af' : '#6b7280', fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis
                  scale={logScale ? 'log' : 'auto'} domain={logScale ? [1, 'auto'] : [0, 'auto']}
                  ticks={logScale ? tickVals : undefined}
                  tickFormatter={(v: number) => v >= 60000 ? `${(v/60000).toFixed(1)}m` : `${(v/1000).toFixed(1)}s`}
                  tick={{ fill: d ? '#6b7280' : '#9ca3af', fontSize: 13 }} axisLine={false} tickLine={false} width={36}
                />
                <RechartsTip
                  contentStyle={{ background: d ? '#0f172a' : '#fff', border: `1px solid ${d ? '#334155' : '#e2e8f0'}`, borderRadius: 8, fontSize: 13, color: d ? '#e2e8f0' : '#1e293b' }}
                  formatter={(value: any, name: any) => [fmtMs(Number(value)), String(name)]}
                  labelFormatter={(label: any, payload: readonly any[]) => {
                    const row = payload?.[0]?.payload;
                    return row ? `${String(label)} — ${row.description}` : String(label);
                  }}
                />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 13, paddingTop: 4, color: d ? '#9ca3af' : '#6b7280' }} />
                <Bar dataKey="engine" fill="#22d3ee" name="GPU Engine" radius={[3,3,0,0]} />
                <Bar dataKey="umbra"  fill="#a78bfa" name="Umbra"  radius={[3,3,0,0]} />
                <Bar dataKey="duckdb" fill="#fb923c" name="DuckDB" radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>
        </div>

        {/* Footer */}
        <div className={`px-5 py-2 shrink-0 border-t text-[14px] ${d ? 'border-gray-700/80 text-gray-600' : 'border-gray-200 text-gray-400'}`}>
          {'The GPU engine supports richer path-aware queries while keeping clear advantages in runtime and memory.'}
        </div>
      </div>
    );
  }

  // ---- Full comparison ----
  const umbraMs  = umbraLive?.ms  ?? null;
  const duckdbMs = duckdbLive?.ms ?? null;

  // Speedup ratios — only when both systems have actual values
  const umbraRatio  = engineMs !== null && umbraMs  !== null ? umbraMs  / engineMs : null;
  const duckdbRatio = engineMs !== null && duckdbMs !== null ? duckdbMs / engineMs : null;

  const systems = [
    { key: 'engine',  label: 'GPU Engine',  sublabel: 'GPU',
      ms: engineMs,  color: '#22d3ee', isActual: engineIsActual,  canRun: false, error: null },
    { key: 'umbra',  label: 'Umbra',  sublabel: 'CPU',
      ms: umbraMs,  color: '#a78bfa', isActual: !!umbraLive, canRun: true, error: umbraError },
    { key: 'duckdb', label: 'DuckDB', sublabel: 'CPU',
      ms: duckdbMs, color: '#fb923c', isActual: !!duckdbLive, canRun: true, error: duckdbError },
  ];

  // Bar chart: systems with measurements + timeout/OOM as capped bars
  const chartData: Array<{ name: string; ms: number; color: string; errorLabel?: string }> = [];
  for (const s of systems) {
    if (s.ms !== null) {
      chartData.push({ name: s.label, ms: s.ms, color: s.color });
    } else {
      const kind = errorKind(s.error);
      if (kind === 'timeout' || kind === 'oom') {
        chartData.push({
          name: s.label,
          ms: kind === 'timeout' ? timeoutSec * 1000 : timeoutSec * 1000,
          color: kind === 'timeout' ? '#f59e0b' : '#ef4444',
          errorLabel: kind === 'timeout' ? 'TIMEOUT' : 'O.O.M',
        });
      }
    }
  }
  const allMs = chartData.map(s => s.ms);
  const maxMs = allMs.length > 0 ? Math.max(...allMs) : 1;

  // No stored memory figures.  The table that used to live here was keyed by a
  // bare "S<n>" prefix against an older numbering of demo-query/, and the files
  // were renumbered underneath it: 13 of its 15 entries had drifted onto a
  // different query, so R1 (KNOWS* closure) was shown the RSS measured for a
  // length-bounded CRPQ.  Memory is now only ever what this run measured.

  // Memory chart data — whatever this run actually measured, nothing else
  const memChartData: Array<{ name: string; gb: number; color: string; errorLabel?: string; isLive?: boolean; sub?: string }> = [];
  const umbraErrKind  = errorKind(umbraError);
  const duckdbErrKind = errorKind(duckdbError);
  const engineMemGb = result?.engine_mem_gb ?? null;
  const hasAnyMemory = engineMemGb != null || umbraLive?.rss != null || duckdbLive?.rss != null
    || umbraErrKind != null || duckdbErrKind != null;
  if (hasAnyMemory) {
    // Engine: measured live from the serving daemon at answer time (host RSS +
    // GPU allocation), never quoted from a stored table — the table that used
    // to live here attributed one query's memory to another.
    if (engineMemGb != null) {
      const host = result?.mem_host_gb, gpu = result?.mem_gpu_gb;
      memChartData.push({
        name: 'GPU Engine', gb: engineMemGb, color: '#22d3ee', isLive: true,
        sub: host != null && gpu != null ? `host ${host} + GPU ${gpu}` : undefined,
      });
    }

    // Umbra: live RSS, or fallback label for OOM/TO
    const umbraRss = umbraLive?.rss;
    if (umbraRss != null) {
      const liveOOM = umbraRss >= OOM_LIMIT_GB;
      memChartData.push({ name: 'Umbra', gb: umbraRss, color: liveOOM ? '#ef4444' : '#a78bfa', isLive: true, errorLabel: liveOOM ? 'O.O.M' : undefined });
    } else if (umbraErrKind === 'oom') {
      memChartData.push({ name: 'Umbra', gb: 0.01, color: '#ef4444', errorLabel: 'O.O.M' });
    } else if (umbraErrKind === 'timeout') {
      memChartData.push({ name: 'Umbra', gb: 0.01, color: '#a78bfa', errorLabel: 'N/A' });
    }

    // DuckDB: live RSS, or fallback label for OOM/TO
    const duckdbRss = duckdbLive?.rss;
    if (duckdbRss != null) {
      const liveOOM = duckdbRss >= OOM_LIMIT_GB;
      memChartData.push({ name: 'DuckDB', gb: duckdbRss, color: liveOOM ? '#ef4444' : '#fb923c', isLive: true, errorLabel: liveOOM ? 'O.O.M' : undefined });
    } else if (duckdbErrKind === 'oom') {
      memChartData.push({ name: 'DuckDB', gb: 0.01, color: '#ef4444', errorLabel: 'O.O.M' });
    } else if (duckdbErrKind === 'timeout') {
      memChartData.push({ name: 'DuckDB', gb: 0.01, color: '#fb923c', errorLabel: 'N/A' });
    }
  }
  const maxMemGb = memChartData.length > 0 ? Math.max(...memChartData.map(x => x.gb)) : 1;

  return (
    <div className={`h-full flex flex-col overflow-hidden ${d ? 'bg-gray-900' : 'bg-white'}`}>
      {/* Header */}
      <div className={`px-5 pt-3 pb-2.5 shrink-0 border-b flex items-center justify-between ${d ? 'border-gray-700/80' : 'border-gray-200'}`}>
        <div>
          <h3 className={`text-sm font-bold ${d ? 'text-gray-100' : 'text-gray-900'}`}>
            Performance comparisons
          </h3>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className={`font-mono font-bold text-base leading-none ${d ? 'text-cyan-400' : 'text-cyan-600'}`}>
              {presetMeta?.shortId ?? stem}
            </span>
            {presetMeta && (
              <span
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold leading-none"
                style={{
                  backgroundColor: presetMeta.color + '22',
                  color: presetMeta.color,
                  border: `1px solid ${presetMeta.color}55`,
                }}
              >
                {presetMeta.constraint}
              </span>
            )}
            {ref && (
              <span className={`text-[13px] ${d ? 'text-gray-500' : 'text-gray-400'}`}>
                {ref.description}
              </span>
            )}
            <span className={`text-[12px] ${d ? 'text-gray-700' : 'text-gray-400'}`}>· LDBC SNB SF=1</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Timeout control */}
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded border text-[14px] ${d ? 'border-gray-700 bg-gray-800/60' : 'border-gray-200 bg-gray-50'}`}>
            <span className={d ? 'text-gray-500' : 'text-gray-400'}>Timeout</span>
            {editingTimeout ? (
              <input
                autoFocus
                type="number"
                min={5}
                max={3600}
                value={timeoutInput}
                onChange={e => setTimeoutInput(e.target.value)}
                onBlur={() => {
                  const v = parseInt(timeoutInput, 10);
                  if (!isNaN(v) && v >= 5) setTimeoutSec(v);
                  else setTimeoutInput(String(timeoutSec));
                  setEditingTimeout(false);
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === 'Escape') {
                    const v = parseInt(timeoutInput, 10);
                    if (e.key === 'Enter' && !isNaN(v) && v >= 5) setTimeoutSec(v);
                    else setTimeoutInput(String(timeoutSec));
                    setEditingTimeout(false);
                  }
                }}
                className={`w-12 text-center border rounded px-1 py-0 text-[14px] font-mono outline-none ${d ? 'bg-gray-700 border-gray-500 text-gray-100' : 'bg-white border-gray-300 text-gray-800'}`}
              />
            ) : (
              <button
                onClick={() => { setTimeoutInput(String(timeoutSec)); setEditingTimeout(true); }}
                className={`font-mono font-semibold hover:underline ${d ? 'text-cyan-400 hover:text-cyan-300' : 'text-cyan-600 hover:text-cyan-700'}`}
                title="Click to edit timeout"
              >
                {timeoutSec}s
              </button>
            )}
          </div>
          <button
            className={`text-[14px] px-2 py-1 rounded border transition-colors ${
              logScale
                ? d ? 'bg-cyan-900/30 border-cyan-700/60 text-cyan-300' : 'bg-cyan-50 border-cyan-300 text-cyan-600'
                : d ? 'bg-gray-800 border-gray-600 text-gray-400' : 'bg-white border-gray-300 text-gray-500'
            }`}
            onClick={() => setLogScale(v => !v)}
            title="Toggle log/linear scale"
          >
            Log
          </button>
        </div>
      </div>

      {/* Metric cards */}
      <div className={`grid grid-cols-3 divide-x shrink-0 ${d ? 'divide-gray-700/80 border-b border-gray-700/80' : 'divide-gray-200 border-b border-gray-200'}`}>
        {systems.map(sys => {
          const isWinner = sys.key === 'engine';
          const ratio = (sys.ms !== null && engineMs !== null) ? sys.ms / engineMs : null;
          const badge = (!isWinner && ratio !== null) ? speedupBadgeColor(ratio, d) : null;
          const isRunning = runningSystem === sys.key;
          return (
            <div key={sys.key} className={`flex flex-col items-center py-1.5 px-2 gap-0.5 ${isWinner ? (d ? 'bg-cyan-900/10' : 'bg-cyan-50/50') : ''}`}>
              <div className="flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: sys.color }} />
                <span className={`text-sm font-bold ${d ? 'text-gray-200' : 'text-gray-800'}`}>{sys.label}</span>
              </div>
              {(() => {
                const kind = errorKind(sys.error);
                const hasError = kind !== null && !isRunning;
                if (isRunning) {
                  return (
                    <span className={`text-base font-bold font-mono mt-0.5 ${d ? 'text-gray-600' : 'text-gray-300'}`}>…</span>
                  );
                }
                if (hasError && (kind === 'timeout' || kind === 'oom')) {
                  return (
                    <div className={`flex flex-col items-center gap-0.5 mt-0.5 px-1.5 py-1 rounded-lg ${
                      kind === 'timeout'
                        ? d ? 'bg-amber-900/20 border border-amber-700/40' : 'bg-amber-50 border border-amber-200'
                        : d ? 'bg-red-900/20 border border-red-700/40' : 'bg-red-50 border border-red-200'
                    }`}>
                      <span className="text-sm leading-none">{kind === 'timeout' ? '⏱' : '💥'}</span>
                      <span className={`text-xs font-bold ${
                        kind === 'timeout'
                          ? d ? 'text-amber-400' : 'text-amber-600'
                          : d ? 'text-red-400' : 'text-red-600'
                      }`}>
                        {kind === 'timeout' ? 'TIMEOUT' : 'O.O.M'}
                      </span>
                      <span className={`text-[15px] text-center ${d ? 'text-gray-500' : 'text-gray-400'}`}>
                        {kind === 'timeout' ? `>${timeoutSec}s` : 'Out of Memory'}
                      </span>
                    </div>
                  );
                }
                return (
                  <span className={`text-base font-bold font-mono mt-0.5 ${
                    isWinner ? (d ? 'text-cyan-400' : 'text-cyan-600') : (d ? 'text-gray-300' : 'text-gray-700')
                  }`}>
                    {sys.ms !== null ? fmtMs(sys.ms) : '—'}
                  </span>
                );
              })()}
              {!isWinner && badge && !isRunning && !errorKind(sys.error) && (
                <span
                  className="text-[11px] font-bold px-1.5 py-0.5 rounded-full mt-0.5"
                  style={{ backgroundColor: badge.bg, color: badge.text }}
                >
                  {speedupLabel(ratio!)} slower
                </span>
              )}
              {isWinner && (
                <span className={`text-[10px] mt-0.5 ${d ? 'text-cyan-600' : 'text-cyan-500'}`}>● fastest</span>
              )}
              {/* Run / Stop button for Umbra and DuckDB */}
              {sys.canRun && presetFilename && (
                isRunning ? (
                  <button
                    onClick={handleStop}
                    disabled={isCancelling}
                    className={`text-[11px] px-2 py-0.5 rounded font-semibold flex items-center gap-1 transition-all mt-0.5 ${
                      isCancelling
                        ? d ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                        : 'bg-red-600 hover:bg-red-500 active:bg-red-700 text-white shadow-sm shadow-red-600/30'
                    }`}
                  >
                    {isCancelling
                      ? <><span className="inline-block w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin" />Stopping…</>
                      : <><svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor"><rect width="8" height="8" rx="1"/></svg>Stop</>
                    }
                  </button>
                ) : (
                  <button
                    disabled={runningSystem !== null}
                    onClick={() => handleRun(sys.key as 'umbra' | 'duckdb')}
                    className={`text-[11px] px-1.5 py-0.5 rounded border transition-colors mt-0.5 ${
                      runningSystem !== null
                        ? d ? 'border-gray-700 text-gray-600 cursor-not-allowed' : 'border-gray-200 text-gray-400 cursor-not-allowed'
                        : d ? 'border-gray-600 text-gray-400 hover:border-cyan-700/60 hover:text-cyan-400' : 'border-gray-300 text-gray-500 hover:border-cyan-400 hover:text-cyan-600'
                    }`}
                  >
                    {sys.isActual ? '↻ Re-run' : '▶ Run live'}
                  </button>
                )
              )}
              {/* Generic error (not timeout/OOM) */}
              {sys.error && !isRunning && errorKind(sys.error) === 'error' && (
                <span
                  className={`text-[10px] text-center max-w-full px-1 truncate ${d ? 'text-red-400' : 'text-red-500'}`}
                  title={sys.error}
                >
                  ⚠ {sys.error.length > 40 ? sys.error.slice(0, 40) + '…' : sys.error}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Equivalent SQL — below metrics, above chart */}
      {currentSQL && (
        <div className={`shrink-0 border-b ${d ? 'border-gray-700/80 bg-gray-950/40' : 'border-gray-200 bg-gray-50/80'}`}>
          <button
            className="w-full flex items-center justify-between px-4 py-1.5 group"
            onClick={() => setShowSQL(v => !v)}
          >
            <div className="flex items-center gap-1.5">
              <svg
                width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"
                className={`transition-transform duration-150 ${showSQL ? 'rotate-90' : ''} ${d ? 'text-violet-500' : 'text-violet-400'}`}
              >
                <path d="M3 2l5 4-5 4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span className={`text-[11px] font-semibold uppercase tracking-wider ${d ? 'text-violet-400 group-hover:text-violet-300' : 'text-violet-500 group-hover:text-violet-700'}`}>
                Equivalent SQL (Umbra / DuckDB)
              </span>
            </div>
            {showSQL && (
              <span
                className={`text-[11px] transition-colors ${copiedSQL ? (d ? 'text-emerald-400' : 'text-emerald-600') : (d ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600')}`}
                onClick={e => { e.stopPropagation(); handleCopySQL(); }}
              >
                {copiedSQL ? '✓ Copied' : 'Copy'}
              </span>
            )}
          </button>
          {showSQL && (
            <pre className={`text-[13px] leading-5 px-4 pb-2.5 overflow-x-auto font-mono max-h-40 ${d ? 'text-gray-300' : 'text-gray-700'}`} style={{ scrollbarWidth: 'thin' }}>
              {currentSQL}
            </pre>
          )}
        </div>
      )}

      {/* Charts: time + memory side-by-side */}
      <div className="flex-1 min-h-0 flex flex-col px-6 py-3 gap-2">
        <div className={`flex-1 min-h-0 flex gap-5 ${hasAnyMemory ? '' : 'items-center'}`}>
          {/* Time chart */}
          <div className="flex-1 min-h-0 flex flex-col gap-1.5">
            <p className={`text-[13px] font-semibold uppercase tracking-wider shrink-0 ${d ? 'text-gray-600' : 'text-gray-400'}`}>
              Elapsed time
            </p>
            <div className="flex-1 min-h-0" style={{ maxHeight: 160 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  layout="vertical"
                  data={chartData}
                  margin={{ top: 4, right: 72, bottom: 4, left: 52 }}
                  barSize={20}
                >
                  <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke={d ? '#1f2937' : '#e5e7eb'} />
                  <XAxis
                    type="number"
                    scale={logScale ? 'log' : 'linear'}
                    domain={logScale ? [1, maxMs * 2] : [0, maxMs * 1.15]}
                    tickFormatter={fmtMs}
                    tick={{ fill: d ? '#4b5563' : '#9ca3af', fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fill: d ? '#9ca3af' : '#6b7280', fontSize: 12, fontWeight: 600 }}
                    axisLine={false}
                    tickLine={false}
                    width={48}
                  />
                  <Bar dataKey="ms" radius={[0, 4, 4, 0]}>
                    {chartData.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} fillOpacity={entry.errorLabel ? 0.35 : 1} />
                    ))}
                    <LabelList
                      dataKey="ms"
                      position="right"
                      content={({ x, y, width, height, index }: any) => {
                        const entry = chartData[index];
                        if (!entry) return null;
                        const label = entry.errorLabel ?? fmtMs(entry.ms);
                        const clr = entry.errorLabel
                          ? (entry.errorLabel === 'TIMEOUT' ? '#f59e0b' : '#ef4444')
                          : (d ? '#9ca3af' : '#6b7280');
                        return (
                          <text
                            x={(x as number) + (width as number) + 5}
                            y={(y as number) + (height as number) / 2}
                            fill={clr}
                            fontSize={11}
                            fontFamily="ui-monospace, monospace"
                            fontWeight={entry.errorLabel ? 700 : 400}
                            dominantBaseline="central"
                          >
                            {label}
                          </text>
                        );
                      }}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Memory peak chart */}
          {hasAnyMemory && memChartData.length > 0 && (
            <div className="flex-1 min-h-0 flex flex-col gap-1.5">
              <p className={`text-[13px] font-semibold uppercase tracking-wider shrink-0 ${d ? 'text-emerald-700' : 'text-emerald-600'}`}>
                Memory peak
              </p>
              <div className="flex-1 min-h-0" style={{ maxHeight: 160 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    layout="vertical"
                    data={memChartData}
                    margin={{ top: 4, right: 80, bottom: 4, left: 52 }}
                    barSize={20}
                  >
                    <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke={d ? '#1f2937' : '#e5e7eb'} />
                    <XAxis
                      type="number"
                      scale="log"
                      domain={[0.01, maxMemGb * 2]}
                      tickFormatter={(v: number) => v < 1 ? `${(v * 1000).toFixed(0)}M` : `${v >= 100 ? v.toFixed(0) : v.toFixed(v >= 10 ? 0 : 1)}G`}
                      tick={{ fill: d ? '#4b5563' : '#9ca3af', fontSize: 12 }}
                      axisLine={false}
                      tickLine={false}
                      allowDataOverflow
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      tick={{ fill: d ? '#9ca3af' : '#6b7280', fontSize: 12, fontWeight: 600 }}
                      axisLine={false}
                      tickLine={false}
                      width={48}
                    />
                    <Bar dataKey="gb" radius={[0, 4, 4, 0]}>
                      {memChartData.map((entry) => (
                        <Cell key={entry.name} fill={entry.color} fillOpacity={entry.errorLabel ? 0.35 : 1} />
                      ))}
                      <LabelList
                        dataKey="gb"
                        position="right"
                        content={({ x, y, width, height, index }: any) => {
                          const entry = memChartData[index];
                          if (!entry) return null;
                          const label = entry.errorLabel ?? (entry.sub ? `${fmtGb(entry.gb)}  (${entry.sub})` : fmtGb(entry.gb));
                          const clr = entry.errorLabel
                            ? '#f59e0b'
                            : (d ? '#9ca3af' : '#6b7280');
                          return (
                            <text
                              x={(x as number) + (width as number) + 5}
                              y={(y as number) + (height as number) / 2}
                              fill={clr}
                              fontSize={11}
                              fontFamily="ui-monospace, monospace"
                              fontWeight={entry.errorLabel ? 700 : 400}
                              dominantBaseline="central"
                            >
                              {label}
                            </text>
                          );
                        }}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>

        {/* Speedup summary row — only shown when both systems have actual values */}
        {(umbraRatio !== null || duckdbRatio !== null) && (
          <div className={`flex items-center gap-4 pt-2 border-t shrink-0 ${d ? 'border-gray-700/80' : 'border-gray-200'}`}>
            <span className={`text-[13px] font-semibold uppercase tracking-wider shrink-0 ${d ? 'text-gray-600' : 'text-gray-400'}`}>
              Engine speedup
            </span>
            <div className="flex items-center gap-3">
              {([
                { label: 'vs Umbra',  ratio: umbraRatio },
                { label: 'vs DuckDB', ratio: duckdbRatio },
              ] as const).filter(x => x.ratio !== null).map(({ label, ratio }) => {
                const badge = speedupBadgeColor(ratio!, d);
                return (
                  <div key={label} className="flex items-center gap-1.5">
                    <span className={`text-[13px] ${d ? 'text-gray-500' : 'text-gray-400'}`}>{label}</span>
                    <span
                      className="text-[14px] font-bold px-2 py-0.5 rounded-full"
                      style={{ backgroundColor: badge.bg, color: badge.text }}
                    >
                      {speedupLabel(ratio!)} faster
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

    </div>
  );
};

export default BenchmarkPanel;
