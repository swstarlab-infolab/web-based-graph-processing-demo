import type { Schema, QueryResult, PresetQuery, Dataset } from '../types';

export const MOCK_SCHEMA: Schema = {
  vertex_labels: [
    'Person', 'Post', 'Comment', 'Tag', 'Forum', 'University',
    'Company', 'City', 'Country', 'Continent', 'TagClass', 'Message',
  ],
  edge_labels: [
    'KNOWS', 'LIKES', 'HAS_CREATOR', 'HAS_TAG', 'REPLY_OF',
    'IS_LOCATED_IN', 'STUDY_AT', 'WORK_AT', 'HAS_INTEREST',
    'HAS_MEMBER', 'CONTAINER_OF', 'HAS_MODERATOR', 'IS_PART_OF',
    'IS_SUBCLASS_OF', 'HAS_TYPE',
  ],
  undirected_edge_labels: ['KNOWS'],
  edge_endpoints: {
    KNOWS: [{ source: 'Person', target: 'Person' }],
    LIKES: [{ source: 'Person', target: 'Comment' }, { source: 'Person', target: 'Post' }],
    HAS_CREATOR: [{ source: 'Comment', target: 'Person' }, { source: 'Post', target: 'Person' }],
    HAS_TAG: [{ source: 'Comment', target: 'Tag' }, { source: 'Forum', target: 'Tag' }, { source: 'Post', target: 'Tag' }],
    REPLY_OF: [{ source: 'Comment', target: 'Comment' }, { source: 'Comment', target: 'Post' }],
    HAS_INTEREST: [{ source: 'Person', target: 'Tag' }],
    HAS_MEMBER: [{ source: 'Forum', target: 'Person' }],
    CONTAINER_OF: [{ source: 'Forum', target: 'Post' }],
    HAS_MODERATOR: [{ source: 'Forum', target: 'Person' }],
    STUDY_AT: [{ source: 'Person', target: 'University' }],
    WORK_AT: [{ source: 'Person', target: 'Company' }],
    IS_LOCATED_IN: [
      { source: 'Company', target: 'Country' }, { source: 'University', target: 'City' },
      { source: 'Comment', target: 'Country' }, { source: 'Person', target: 'City' },
      { source: 'Post', target: 'Country' },
    ],
    IS_PART_OF: [{ source: 'City', target: 'Country' }, { source: 'Country', target: 'Continent' }],
    IS_SUBCLASS_OF: [{ source: 'TagClass', target: 'TagClass' }],
    HAS_TYPE: [{ source: 'Tag', target: 'TagClass' }],
  },
};

export const MOCK_DATASETS: Dataset[] = [
  { id: 'LDBC_SNB_sf1', name: 'LDBC SNB SF=1', schema: 'LDBC_SNB', loaded: true },
  { id: 'LDBC_SNB_sf10', name: 'LDBC SNB SF=10', schema: 'LDBC_SNB', loaded: false },
];

export const MOCK_RESULT_WE: QueryResult = {
  query_type: 'word_equality',
  total_count: 72042796,
  elapsed_ms: 9.2,
  samples: [
    { vertices: [34, 891, 102], edge_labels: ['KNOWS', 'KNOWS'] },
    { vertices: [34, 567, 102], edge_labels: ['KNOWS', 'KNOWS'] },
    { vertices: [12, 567, 88], edge_labels: ['KNOWS', 'KNOWS'] },
    { vertices: [56, 234, 789], edge_labels: ['KNOWS', 'KNOWS'] },
  ],
};

export const MOCK_RESULT_RPQ: QueryResult = {
  query_type: 'rpq',
  total_count: 98012,
  elapsed_ms: 3.1,
  samples: [
    { vertices: [34, 891], edge_labels: ['KNOWS'] },
    { vertices: [34, 567], edge_labels: ['KNOWS'] },
    { vertices: [891, 102], edge_labels: ['KNOWS'] },
    { vertices: [567, 102], edge_labels: ['KNOWS'] },
  ],
};


export const MOCK_PRESETS: PresetQuery[] = [
  // ── S1–S5: RPQ ──────────────────────────────────────────────────────────
  {
    name: 'S1: RPQ multi-label social reachability',
    filename: 'S1-rpq-friend-transitive.json',
    content: {
      query_vertices: ['v1:Any', 'v2:Any'],
      query_edges: ['(v1)-[P1]->(v2)'],
      automata: {
        P1: {
          regular_expression: '(KNOWS|HAS_INTEREST)*',
          states: ['q0'],
          alphabets: ['KNOWS', 'HAS_INTEREST'],
          transitions: [['q0', 'KNOWS-', 'q0'], ['q0', 'HAS_INTEREST-', 'q0']],
          initial_states: ['q0'],
          final_states: ['q0'],
        },
      },
    },
  },
  {
    name: 'S2: RPQ forum → moderator → friends',
    filename: 'S2-rpq-forum-friend.json',
    content: {
      query_vertices: ['v1:Any', 'v2:Any'],
      query_edges: ['(v1)-[P1]->(v2)'],
      automata: {
        P1: {
          regular_expression: 'HAS_MODERATOR/KNOWS*',
          states: ['q0', 'q1'],
          alphabets: ['HAS_MODERATOR', 'KNOWS'],
          transitions: [['q0', '-KNOWS', 'q0'], ['q0', '-HAS_MODERATOR', 'q1']],
          initial_states: ['q0'],
          final_states: ['q1'],
        },
      },
    },
  },
  {
    name: 'S3: RPQ friend-of-friend interest type',
    filename: 'S3-rpq-friend-interest.json',
    content: {
      query_vertices: ['v1:Any', 'v2:Any'],
      query_edges: ['(v1)-[P1]->(v2)'],
      automata: {
        P1: {
          regular_expression: 'KNOWS/KNOWS/HAS_INTEREST/HAS_TYPE',
          states: ['q0', 'q1', 'q2', 'q3', 'q4'],
          alphabets: ['KNOWS', 'HAS_INTEREST', 'HAS_TYPE'],
          transitions: [['q0', '-HAS_TYPE', 'q1'], ['q1', '-HAS_INTEREST', 'q2'], ['q2', '-KNOWS', 'q3'], ['q3', '-KNOWS', 'q4']],
          initial_states: ['q0'],
          final_states: ['q4'],
        },
      },
    },
  },
  {
    name: 'S4: RPQ forum moderator city reach',
    filename: 'S4-rpq-forum-city.json',
    content: {
      query_vertices: ['v1:Any', 'v2:Any'],
      query_edges: ['(v1)-[P1]->(v2)'],
      automata: {
        P1: {
          regular_expression: 'HAS_MODERATOR/KNOWS*/IS_LOCATED_IN',
          states: ['q0', 'q1', 'q2'],
          alphabets: ['HAS_MODERATOR', 'KNOWS', 'IS_LOCATED_IN'],
          transitions: [['q0', '-IS_LOCATED_IN', 'q1'], ['q1', '-KNOWS', 'q1'], ['q1', '-HAS_MODERATOR', 'q2']],
          initial_states: ['q0'],
          final_states: ['q2'],
        },
      },
    },
  },
  {
    name: 'S5: RPQ optional moderator + multi-label reach',
    filename: 'S5-rpq-optional-moderator.json',
    content: {
      query_vertices: ['v1:Any', 'v2:Any'],
      query_edges: ['(v1)-[P1]->(v2)'],
      automata: {
        P1: {
          regular_expression: 'HAS_MODERATOR?/(KNOWS|HAS_INTEREST)*',
          states: ['q0', 'q1'],
          alphabets: ['HAS_MODERATOR', 'KNOWS', 'HAS_INTEREST'],
          transitions: [
            ['q0', '-KNOWS', 'q0'],
            ['q0', '-HAS_INTEREST', 'q0'],
            ['q0', '-HAS_MODERATOR', 'q1'],
            ['q1', '-KNOWS', 'q1'],
            ['q1', '-HAS_INTEREST', 'q1'],
          ],
          initial_states: ['q0'],
          final_states: ['q0', 'q1'],
        },
      },
    },
  },
  // ── S6–S10: Word Equality ────────────────────────────────────────────────
  {
    name: 'S6: WE friend equality',
    filename: 'S6-we-friend-equality.json',
    content: {
      query_vertices: ['v1:Person', 'v2:Person', 'v3:Person'],
      query_edges: ['(v1)-[P1]->(v2)', '(v1)-[P2]->(v3)'],
      automata: {
        P1: {
          regular_expression: 'KNOWS*',
          states: ['q0'],
          alphabets: ['KNOWS'],
          transitions: [['q0', 'KNOWS-', 'q0']],
          initial_states: ['q0'],
          final_states: ['q0'],
        },
        P2: {
          regular_expression: 'KNOWS*',
          states: ['q0'],
          alphabets: ['KNOWS'],
          transitions: [['q0', 'KNOWS-', 'q0']],
          initial_states: ['q0'],
          final_states: ['q0'],
        },
      },
      word_equality_constraints: [{ path1: 'P1', path2: 'P2', source_constraint: 'same' }],
    },
  },
  {
    name: 'S7: WE reply→tag equality',
    filename: 'S7-we-reply-tag-equality.json',
    content: {
      query_vertices: ['v1:Any', 'v2:Any', 'v3:Any'],
      query_edges: ['(v1)-[P1]->(v2)', '(v1)-[P2]->(v3)'],
      automata: {
        P1: {
          regular_expression: 'REPLY_OF*/HAS_TAG',
          states: ['q0', 'q1'],
          alphabets: ['REPLY_OF', 'HAS_TAG'],
          transitions: [['q0', 'REPLY_OF-', 'q0'], ['q0', 'HAS_TAG-', 'q1']],
          initial_states: ['q0'],
          final_states: ['q1'],
        },
        P2: {
          regular_expression: 'REPLY_OF*/HAS_TAG',
          states: ['q0', 'q1'],
          alphabets: ['REPLY_OF', 'HAS_TAG'],
          transitions: [['q0', 'REPLY_OF-', 'q0'], ['q0', 'HAS_TAG-', 'q1']],
          initial_states: ['q0'],
          final_states: ['q1'],
        },
      },
      word_equality_constraints: [{ path1: 'P1', path2: 'P2', source_constraint: 'same' }],
    },
  },
  {
    name: 'S8: WE diff-regex reply→tag',
    filename: 'S8-we-diff-reply-tag.json',
    content: {
      query_vertices: ['v1:Any', 'v2:Any', 'v3:Any'],
      query_edges: ['(v1)-[P1]->(v2)', '(v1)-[P2]->(v3)'],
      automata: {
        P1: {
          regular_expression: 'REPLY_OF*/HAS_TAG',
          states: ['q0', 'q1'],
          alphabets: ['REPLY_OF', 'HAS_TAG'],
          transitions: [['q0', 'REPLY_OF-', 'q0'], ['q0', 'HAS_TAG-', 'q1']],
          initial_states: ['q0'],
          final_states: ['q1'],
        },
        P2: {
          regular_expression: '(REPLY_OF|HAS_TAG)*',
          states: ['q0'],
          alphabets: ['REPLY_OF', 'HAS_TAG'],
          transitions: [['q0', 'REPLY_OF-', 'q0'], ['q0', 'HAS_TAG-', 'q0']],
          initial_states: ['q0'],
          final_states: ['q0'],
        },
      },
      word_equality_constraints: [{ path1: 'P1', path2: 'P2', source_constraint: 'same' }],
    },
  },
  {
    name: 'S9: WE diff-regex social interest',
    filename: 'S9-we-diff-friend-interest.json',
    content: {
      query_vertices: ['v1:Person', 'v2:Any', 'v3:Any'],
      query_edges: ['(v1)-[P1]->(v2)', '(v1)-[P2]->(v3)'],
      automata: {
        P1: {
          regular_expression: 'KNOWS*/(LIKES|HAS_INTEREST)',
          states: ['q0', 'q1'],
          alphabets: ['KNOWS', 'LIKES', 'HAS_INTEREST'],
          transitions: [['q0', 'KNOWS-', 'q0'], ['q0', 'LIKES-', 'q1'], ['q0', 'HAS_INTEREST-', 'q1']],
          initial_states: ['q0'],
          final_states: ['q1'],
        },
        P2: {
          regular_expression: 'KNOWS*/LIKES*/HAS_INTEREST?',
          states: ['q0', 'q1', 'q2'],
          alphabets: ['KNOWS', 'LIKES', 'HAS_INTEREST'],
          transitions: [
            ['q0', 'KNOWS-', 'q0'],
            ['q0', 'LIKES-', 'q1'],
            ['q1', 'LIKES-', 'q1'],
            ['q0', 'HAS_INTEREST-', 'q2'],
            ['q1', 'HAS_INTEREST-', 'q2'],
          ],
          initial_states: ['q0'],
          final_states: ['q0', 'q1', 'q2'],
        },
      },
      word_equality_constraints: [{ path1: 'P1', path2: 'P2', source_constraint: 'same' }],
    },
  },
  {
    name: 'S10: WE diff-source asymmetric automata',
    filename: 'S10-we-diff-source-friend.json',
    content: {
      query_vertices: ['v1:Person', 'v2:Person', 'v3:Any', 'v4:Any'],
      query_edges: ['(v1)-[P1]->(v3)', '(v2)-[P2]->(v4)', '(v1)-[KNOWS]->(v2)'],
      automata: {
        P1: {
          regular_expression: 'KNOWS*/HAS_INTEREST/HAS_TYPE',
          states: ['q0', 'q1', 'q2'],
          alphabets: ['KNOWS', 'HAS_INTEREST', 'HAS_TYPE'],
          transitions: [['q0', 'KNOWS-', 'q0'], ['q0', 'HAS_INTEREST-', 'q1'], ['q1', 'HAS_TYPE-', 'q2']],
          initial_states: ['q0'],
          final_states: ['q2'],
        },
        P2: {
          regular_expression: '(KNOWS|HAS_INTEREST)*/HAS_TYPE',
          states: ['q0', 'q1'],
          alphabets: ['KNOWS', 'HAS_INTEREST', 'HAS_TYPE'],
          transitions: [['q0', 'KNOWS-', 'q0'], ['q0', 'HAS_INTEREST-', 'q0'], ['q0', 'HAS_TYPE-', 'q1']],
          initial_states: ['q0'],
          final_states: ['q1'],
        },
      },
      word_equality_constraints: [{ path1: 'P1', path2: 'P2', source_constraint: 'different', linking_label: 'KNOWS' }],
    },
  },
  // ── S11–S14: Prefix Word Equality ────────────────────────────────────────
  {
    name: 'S11: Prefix WE nested friendship',
    filename: 'S11-prefix-friend-chain.json',
    content: {
      query_vertices: ['v1:Person', 'v2:Person', 'v3:Person', 'v4:Person'],
      query_edges: ['(v1)-[P1]->(v2)', '(v1)-[P2]->(v3)', '(v2)-[P3]->(v4)'],
      automata: {
        P1: {
          regular_expression: 'KNOWS*',
          states: ['q0'],
          alphabets: ['KNOWS'],
          transitions: [['q0', 'KNOWS-', 'q0']],
          initial_states: ['q0'],
          final_states: ['q0'],
        },
        P2: {
          regular_expression: 'KNOWS*',
          states: ['q0'],
          alphabets: ['KNOWS'],
          transitions: [['q0', 'KNOWS-', 'q0']],
          initial_states: ['q0'],
          final_states: ['q0'],
        },
        P3: {
          regular_expression: 'KNOWS*',
          states: ['q0'],
          alphabets: ['KNOWS'],
          transitions: [['q0', 'KNOWS-', 'q0']],
          initial_states: ['q0'],
          final_states: ['q0'],
        },
      },
      word_equality_constraints: [{ path1: 'P1', path2: 'P2', source_constraint: 'same', type: 'prefix' }],
    },
  },
  {
    name: 'S12: Prefix WE social→interest',
    filename: 'S12-prefix-mixed-friend.json',
    content: {
      query_vertices: ['v1:Person', 'v2:Any', 'v3:Any', 'v4:Any'],
      query_edges: ['(v1)-[P1]->(v2)', '(v1)-[P2]->(v3)', '(v2)-[P3]->(v4)'],
      automata: {
        P1: {
          regular_expression: 'KNOWS*',
          states: ['q0'],
          alphabets: ['KNOWS'],
          transitions: [['q0', 'KNOWS-', 'q0']],
          initial_states: ['q0'],
          final_states: ['q0'],
        },
        P2: {
          regular_expression: '(KNOWS|HAS_INTEREST)*',
          states: ['q0'],
          alphabets: ['KNOWS', 'HAS_INTEREST'],
          transitions: [['q0', 'KNOWS-', 'q0'], ['q0', 'HAS_INTEREST-', 'q0']],
          initial_states: ['q0'],
          final_states: ['q0'],
        },
        P3: {
          regular_expression: 'HAS_INTEREST',
          states: ['q0', 'q1'],
          alphabets: ['HAS_INTEREST'],
          transitions: [['q0', 'HAS_INTEREST-', 'q1']],
          initial_states: ['q0'],
          final_states: ['q1'],
        },
      },
      word_equality_constraints: [{ path1: 'P1', path2: 'P2', source_constraint: 'same', type: 'prefix' }],
    },
  },
  {
    name: 'S13: Prefix WE like→reply depth',
    filename: 'S13-prefix-like-reply.json',
    content: {
      query_vertices: ['v1:Any', 'v2:Any', 'v3:Any', 'v4:Any'],
      query_edges: ['(v1)-[P1]->(v2)', '(v1)-[P2]->(v3)', '(v2)-[P3]->(v4)'],
      automata: {
        P1: {
          regular_expression: 'LIKES/REPLY_OF*',
          states: ['q0', 'q1'],
          alphabets: ['LIKES', 'REPLY_OF'],
          transitions: [['q0', 'LIKES-', 'q1'], ['q1', 'REPLY_OF-', 'q1']],
          initial_states: ['q0'],
          final_states: ['q1'],
        },
        P2: {
          regular_expression: 'LIKES/REPLY_OF*',
          states: ['q0', 'q1'],
          alphabets: ['LIKES', 'REPLY_OF'],
          transitions: [['q0', 'LIKES-', 'q1'], ['q1', 'REPLY_OF-', 'q1']],
          initial_states: ['q0'],
          final_states: ['q1'],
        },
        P3: {
          regular_expression: 'HAS_TAG',
          states: ['q0', 'q1'],
          alphabets: ['HAS_TAG'],
          transitions: [['q0', 'HAS_TAG-', 'q1']],
          initial_states: ['q0'],
          final_states: ['q1'],
        },
      },
      word_equality_constraints: [{ path1: 'P1', path2: 'P2', source_constraint: 'same', type: 'prefix' }],
    },
  },
  {
    name: 'S14: Prefix WE mixed chain',
    filename: 'S14-prefix-mixed-chain.json',
    content: {
      query_vertices: ['v1:Person', 'v2:Any', 'v3:Any', 'v4:Any'],
      query_edges: ['(v1)-[P1]->(v2)', '(v1)-[P2]->(v3)', '(v2)-[P3]->(v4)'],
      automata: {
        P1: {
          regular_expression: '(KNOWS|HAS_INTEREST)',
          states: ['q0', 'q1'],
          alphabets: ['KNOWS', 'HAS_INTEREST'],
          transitions: [['q0', 'KNOWS-', 'q1'], ['q0', 'HAS_INTEREST-', 'q1']],
          initial_states: ['q0'],
          final_states: ['q1'],
        },
        P2: {
          regular_expression: '(KNOWS|HAS_INTEREST)*',
          states: ['q0'],
          alphabets: ['KNOWS', 'HAS_INTEREST'],
          transitions: [['q0', 'KNOWS-', 'q0'], ['q0', 'HAS_INTEREST-', 'q0']],
          initial_states: ['q0'],
          final_states: ['q0'],
        },
        P3: {
          regular_expression: '(KNOWS|HAS_INTEREST)',
          states: ['q0', 'q1'],
          alphabets: ['KNOWS', 'HAS_INTEREST'],
          transitions: [['q0', 'KNOWS-', 'q1'], ['q0', 'HAS_INTEREST-', 'q1']],
          initial_states: ['q0'],
          final_states: ['q1'],
        },
      },
      word_equality_constraints: [{ path1: 'P1', path2: 'P2', source_constraint: 'same', type: 'prefix' }],
    },
  },
  // ── S15–S17: CRPQ + Length ────────────────────────────────────────────────
  {
    name: 'S15: CRPQ bounded friendship triangle',
    filename: 'S15-crpq-length-friend-triangle.json',
    content: {
      query_vertices: ['post:Post', 'person2:Person', 'comment:Comment', 'person1:Person'],
      query_edges: [
        '(comment)-[REPLY_OF]->(post)',
        '(person1)<-[HAS_CREATOR]-(comment)',
        '(post)-[HAS_CREATOR]->(person2)',
        '(person1)-[P1]->(person2)',
      ],
      automata: {
        P1: {
          regular_expression: 'KNOWS{1,3}',
          min_length: 1,
          max_length: 3,
          states: ['q0'],
          alphabets: ['KNOWS'],
          transitions: [['q0', 'KNOWS-', 'q0']],
          initial_states: ['q0'],
          final_states: ['q0'],
        },
      },
    },
  },
  {
    name: 'S16: CRPQ bounded reply→tag + interest',
    filename: 'S16-crpq-length-friend-interest.json',
    content: {
      query_vertices: ['comment:Comment', 'tag:Tag', 'tag2:Tag', 'person:Person'],
      query_edges: [
        '(tag)<-[P1]-(comment)',
        '(comment)-[HAS_TAG]->(tag2)',
        '(person)-[HAS_INTEREST]->(tag)',
      ],
      automata: {
        P1: {
          regular_expression: 'REPLY_OF{1,3}/HAS_TAG',
          min_length: 2,
          max_length: 4,
          states: ['q0', 'q1', 'q2', 'q3', 'q4'],
          alphabets: ['REPLY_OF', 'HAS_TAG'],
          transitions: [
            ['q0', 'REPLY_OF-', 'q1'],
            ['q1', 'REPLY_OF-', 'q2'],
            ['q2', 'REPLY_OF-', 'q3'],
            ['q1', 'HAS_TAG-', 'q4'],
            ['q2', 'HAS_TAG-', 'q4'],
            ['q3', 'HAS_TAG-', 'q4'],
          ],
          initial_states: ['q0'],
          final_states: ['q4'],
        },
      },
    },
  },
  {
    name: 'S17: CRPQ dual bounded paths',
    filename: 'S17-crpq-length-dual-bounded.json',
    content: {
      query_vertices: ['post:Post', 'person2:Person', 'comment:Comment', 'person1:Person'],
      query_edges: [
        '(comment)-[P2]->(post)',
        '(person1)<-[HAS_CREATOR]-(comment)',
        '(post)-[HAS_CREATOR]->(person2)',
        '(person1)-[P1]->(person2)',
      ],
      automata: {
        P1: {
          regular_expression: 'KNOWS{1,2}',
          min_length: 1,
          max_length: 2,
          states: ['q0'],
          alphabets: ['KNOWS'],
          transitions: [['q0', 'KNOWS-', 'q0']],
          initial_states: ['q0'],
          final_states: ['q0'],
        },
        P2: {
          regular_expression: 'REPLY_OF{1,3}',
          min_length: 1,
          max_length: 3,
          states: ['q0'],
          alphabets: ['REPLY_OF'],
          transitions: [['q0', 'REPLY_OF-', 'q0']],
          initial_states: ['q0'],
          final_states: ['q0'],
        },
      },
    },
  },
  // ── S18–S19: RPQ + Length ─────────────────────────────────────────────────
  {
    name: 'S18: RPQ bounded friend-liked',
    filename: 'S18-rpq-length-friend-liked.json',
    content: {
      query_vertices: ['v1:Any', 'v2:Any'],
      query_edges: ['(v1)-[P1]->(v2)'],
      automata: {
        P1: {
          regular_expression: 'KNOWS{1,3}/LIKES*',
          min_length: 1,
          max_length: 4,
          states: ['q0', 'q1'],
          alphabets: ['KNOWS', 'LIKES'],
          transitions: [['q0', 'KNOWS-', 'q0'], ['q0', 'LIKES-', 'q1'], ['q1', 'LIKES-', 'q1']],
          initial_states: ['q0'],
          final_states: ['q0', 'q1'],
        },
      },
    },
  },
  {
    name: 'S19: RPQ bounded reply→tag',
    filename: 'S19-rpq-length-reply-tag.json',
    content: {
      query_vertices: ['v1:Any', 'v2:Any'],
      query_edges: ['(v1)-[P1]->(v2)'],
      automata: {
        P1: {
          regular_expression: 'REPLY_OF{0,2}/HAS_TAG',
          min_length: 1,
          max_length: 3,
          states: ['q0', 'q1'],
          alphabets: ['REPLY_OF', 'HAS_TAG'],
          transitions: [['q0', 'REPLY_OF-', 'q0'], ['q0', 'HAS_TAG-', 'q1']],
          initial_states: ['q0'],
          final_states: ['q1'],
        },
      },
    },
  },
];
