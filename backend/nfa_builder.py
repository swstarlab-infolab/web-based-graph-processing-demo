"""Convert regex patterns to the engine automaton JSON format.

Implements Thompson's construction adapted for the engine's NFA format.
The automaton format matches the JSON files in queries/.

Supported syntax:
    LABEL           single edge traversal
    LABEL*          Kleene star (zero or more)
    LABEL+          one or more
    LABEL?          zero or one
    A/B             concatenation (A then B)
    A|B             alternation (A or B)

Direction suffixes on transitions:
    "LABEL-"        forward / append direction
    "-LABEL"        reverse / prepend direction
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class NFA:
    """Intermediate NFA representation before serializing to engine JSON."""

    states: list[str] = field(default_factory=list)
    alphabets: set[str] = field(default_factory=set)
    transitions: list[list[str]] = field(default_factory=list)
    initial_states: list[str] = field(default_factory=list)
    final_states: list[str] = field(default_factory=list)


def _make_state(index: int) -> str:
    return f"q{index}"


def _tokenize(regex: str) -> list[str]:
    """Tokenize a regex string into labels and operators.

    Returns a list of tokens. Labels are alphanumeric strings (plus
    underscores). Operators are ``*``, ``+``, ``?``, ``/``, ``|``,
    ``(``, ``)``.
    """
    tokens: list[str] = []
    i = 0
    while i < len(regex):
        ch = regex[i]
        if ch in ("*", "+", "?", "/", "|", "(", ")"):
            tokens.append(ch)
            i += 1
        elif ch == " ":
            i += 1  # skip whitespace
        else:
            # Read a label name (letters, digits, underscores)
            j = i
            while j < len(regex) and regex[j] not in ("*", "+", "?", "/", "|", "(", ")", " "):
                j += 1
            tokens.append(regex[i:j])
            i = j
    return tokens


def _parse_regex(tokens: list[str], pos: int = 0) -> tuple[NFA, int]:
    """Recursive descent parser for regex -> NFA.

    Grammar:
        expr       -> concat ('|' concat)*
        concat     -> unary ('/' unary)*
        unary      -> atom ('*' | '+' | '?')?
        atom       -> LABEL | '(' expr ')'
    """
    nfa, pos = _parse_alternation(tokens, pos)
    return nfa, pos


def _parse_alternation(tokens: list[str], pos: int) -> tuple[NFA, int]:
    """Parse alternation: concat ('|' concat)*"""
    left, pos = _parse_concatenation(tokens, pos)
    while pos < len(tokens) and tokens[pos] == "|":
        pos += 1  # skip '|'
        right, pos = _parse_concatenation(tokens, pos)
        left = _merge_alternation(left, right)
    return left, pos


def _parse_concatenation(tokens: list[str], pos: int) -> tuple[NFA, int]:
    """Parse concatenation: unary ('/' unary)*"""
    left, pos = _parse_unary(tokens, pos)
    while pos < len(tokens) and tokens[pos] == "/":
        pos += 1  # skip '/'
        right, pos = _parse_unary(tokens, pos)
        left = _merge_concatenation(left, right)
    return left, pos


def _parse_unary(tokens: list[str], pos: int) -> tuple[NFA, int]:
    """Parse unary: atom ('*' | '+' | '?')?"""
    nfa, pos = _parse_atom(tokens, pos)
    if pos < len(tokens) and tokens[pos] in ("*", "+", "?"):
        op = tokens[pos]
        pos += 1
        nfa = _apply_quantifier(nfa, op)
    return nfa, pos


def _parse_atom(tokens: list[str], pos: int) -> tuple[NFA, int]:
    """Parse atom: LABEL | '(' expr ')'"""
    if pos >= len(tokens):
        raise ValueError("Unexpected end of regex")

    if tokens[pos] == "(":
        pos += 1  # skip '('
        nfa, pos = _parse_regex(tokens, pos)
        if pos >= len(tokens) or tokens[pos] != ")":
            raise ValueError("Expected closing parenthesis")
        pos += 1  # skip ')'
        return nfa, pos

    # Must be a label
    label = tokens[pos]
    if label in ("*", "+", "?", "/", "|", "(", ")"):
        raise ValueError(f"Unexpected operator '{label}' where label expected")
    pos += 1
    return _make_single_label_nfa(label), pos


def _make_single_label_nfa(label: str) -> NFA:
    """Create NFA for a single label traversal: q0 --LABEL--> q1."""
    nfa = NFA()
    nfa.states = ["q0", "q1"]
    nfa.alphabets = {label}
    nfa.transitions = [["q0", f"{label}-", "q1"]]
    nfa.initial_states = ["q0"]
    nfa.final_states = ["q1"]
    return nfa


def _renumber_states(nfa: NFA, offset: int) -> NFA:
    """Renumber all states in an NFA by adding an offset."""
    mapping = {}
    new_states = []
    for s in nfa.states:
        # Extract the number from qN
        num = int(s[1:])
        new_name = _make_state(num + offset)
        mapping[s] = new_name
        new_states.append(new_name)

    return NFA(
        states=new_states,
        alphabets=set(nfa.alphabets),
        transitions=[
            [mapping[t[0]], t[1], mapping[t[2]]] for t in nfa.transitions
        ],
        initial_states=[mapping[s] for s in nfa.initial_states],
        final_states=[mapping[s] for s in nfa.final_states],
    )


def _merge_concatenation(left: NFA, right: NFA) -> NFA:
    """Concatenate two NFAs by merging left's final states with right's initial.

    For the engine's epsilon-free format, we merge the final states of `left`
    with the initial states of `right` (they become the same state).
    """
    # Renumber right's states to continue after left's
    left_max = max(int(s[1:]) for s in left.states)
    # The initial state of right merges with the final state(s) of left.
    # For simplicity, we renumber right starting after left, then add
    # epsilon-free transitions by bridging final(left) to initial(right).

    # If left has exactly one final state and right has exactly one initial,
    # we can merge them directly (this is the common case for the engine).
    if len(left.final_states) == 1 and len(right.initial_states) == 1:
        right_renumbered = _renumber_states(right, left_max)
        # Map right's initial state to left's final state
        right_init = right_renumbered.initial_states[0]
        left_final = left.final_states[0]

        # Replace right_init with left_final everywhere in right
        state_map = {right_init: left_final}
        new_right_states = []
        for s in right_renumbered.states:
            mapped = state_map.get(s, s)
            if mapped not in left.states and mapped not in new_right_states:
                new_right_states.append(mapped)

        all_states = list(left.states) + new_right_states
        all_transitions = list(left.transitions) + [
            [state_map.get(t[0], t[0]), t[1], state_map.get(t[2], t[2])]
            for t in right_renumbered.transitions
        ]
        new_final = [state_map.get(s, s) for s in right_renumbered.final_states]

        return NFA(
            states=all_states,
            alphabets=left.alphabets | right_renumbered.alphabets,
            transitions=all_transitions,
            initial_states=list(left.initial_states),
            final_states=new_final,
        )

    # General case: add transitions from all final(left) to successors of initial(right)
    right_renumbered = _renumber_states(right, left_max + 1)
    all_states = list(left.states) + list(right_renumbered.states)
    all_transitions = list(left.transitions)

    # For each transition from right's initial states, duplicate it from each
    # of left's final states (epsilon-free merge)
    right_init_set = set(right_renumbered.initial_states)
    for t in right_renumbered.transitions:
        if t[0] in right_init_set:
            for lf in left.final_states:
                all_transitions.append([lf, t[1], t[2]])
        all_transitions.append(t)

    return NFA(
        states=all_states,
        alphabets=left.alphabets | right_renumbered.alphabets,
        transitions=all_transitions,
        initial_states=list(left.initial_states),
        final_states=list(right_renumbered.final_states),
    )


def _merge_alternation(left: NFA, right: NFA) -> NFA:
    """Merge two NFAs for alternation (A|B).

    Creates an epsilon-free NFA where both branches share
    initial and final states.
    """
    # Renumber right to avoid state collisions
    left_max = max(int(s[1:]) for s in left.states)
    right_renumbered = _renumber_states(right, left_max + 1)

    # Create a new initial state and new final state
    right_max = max(int(s[1:]) for s in right_renumbered.states)
    new_init_num = max(left_max, right_max) + 1
    new_final_num = new_init_num + 1
    new_init = _make_state(new_init_num)
    new_final = _make_state(new_final_num)

    all_states = [new_init] + left.states + right_renumbered.states + [new_final]
    all_transitions = []

    # Redirect: transitions from left's initial states are duplicated from new_init
    left_init_set = set(left.initial_states)
    for t in left.transitions:
        all_transitions.append(t)
        if t[0] in left_init_set:
            all_transitions.append([new_init, t[1], t[2]])

    # Same for right
    right_init_set = set(right_renumbered.initial_states)
    for t in right_renumbered.transitions:
        all_transitions.append(t)
        if t[0] in right_init_set:
            all_transitions.append([new_init, t[1], t[2]])

    # Redirect transitions going to left/right final states to also go to new_final
    left_final_set = set(left.final_states)
    right_final_set = set(right_renumbered.final_states)
    extra_transitions = []
    for t in all_transitions:
        if t[2] in left_final_set or t[2] in right_final_set:
            if t[2] != new_final:
                extra_transitions.append([t[0], t[1], new_final])
    all_transitions.extend(extra_transitions)

    # If any initial state is also final (zero-length path), mark new_init as final too
    init_is_final = bool(
        (left_init_set & left_final_set)
        or (right_init_set & right_final_set)
    )
    final_states = [new_final]
    if init_is_final:
        final_states.insert(0, new_init)

    return NFA(
        states=all_states,
        alphabets=left.alphabets | right_renumbered.alphabets,
        transitions=all_transitions,
        initial_states=[new_init],
        final_states=final_states,
    )


def _apply_quantifier(nfa: NFA, op: str) -> NFA:
    """Apply a quantifier (*, +, ?) to an NFA.

    For the engine format:
    - ``*``: self-loop on initial state, initial == final (single state if simple)
    - ``+``: keep normal NFA, add self-loop on final state
    - ``?``: keep normal NFA, add initial state to final states
    """
    if op == "*":
        return _apply_star(nfa)
    if op == "+":
        return _apply_plus(nfa)
    if op == "?":
        return _apply_optional(nfa)
    raise ValueError(f"Unknown quantifier: {op}")


def _apply_star(nfa: NFA) -> NFA:
    """Apply Kleene star.

    For a simple single-label NFA (q0->q1), collapse to single state with
    self-loop, matching the engine convention.
    """
    # Simple case: single label with two states
    if len(nfa.states) == 2 and len(nfa.transitions) == 1:
        label_with_dir = nfa.transitions[0][1]
        return NFA(
            states=["q0"],
            alphabets=set(nfa.alphabets),
            transitions=[["q0", label_with_dir, "q0"]],
            initial_states=["q0"],
            final_states=["q0"],
        )

    # General case: add self-loops from final->initial transitions
    # and mark initial states as also final
    new_transitions = list(nfa.transitions)
    init_set = set(nfa.initial_states)
    final_set = set(nfa.final_states)

    # For each transition from an initial state, also add from each final state
    for t in nfa.transitions:
        if t[0] in init_set:
            for fs in nfa.final_states:
                new_trans = [fs, t[1], t[2]]
                if new_trans not in new_transitions:
                    new_transitions.append(new_trans)

    # Initial states are also final (zero-length match)
    new_final = list(nfa.final_states)
    for s in nfa.initial_states:
        if s not in new_final:
            new_final.append(s)

    return NFA(
        states=list(nfa.states),
        alphabets=set(nfa.alphabets),
        transitions=new_transitions,
        initial_states=list(nfa.initial_states),
        final_states=new_final,
    )


def _apply_plus(nfa: NFA) -> NFA:
    """Apply one-or-more quantifier.

    Add self-loop on final state(s) using transitions from initial state(s).
    """
    new_transitions = list(nfa.transitions)
    init_set = set(nfa.initial_states)

    # For each transition from initial states, duplicate from final states
    for t in nfa.transitions:
        if t[0] in init_set:
            for fs in nfa.final_states:
                new_trans = [fs, t[1], t[2]]
                if new_trans not in new_transitions:
                    new_transitions.append(new_trans)

    return NFA(
        states=list(nfa.states),
        alphabets=set(nfa.alphabets),
        transitions=new_transitions,
        initial_states=list(nfa.initial_states),
        final_states=list(nfa.final_states),
    )


def _apply_optional(nfa: NFA) -> NFA:
    """Apply zero-or-one quantifier.

    Mark initial states as also final (allows zero-length match).
    """
    new_final = list(nfa.final_states)
    for s in nfa.initial_states:
        if s not in new_final:
            new_final.insert(0, s)

    return NFA(
        states=list(nfa.states),
        alphabets=set(nfa.alphabets),
        transitions=list(nfa.transitions),
        initial_states=list(nfa.initial_states),
        final_states=new_final,
    )


def _normalize_nfa(nfa: NFA) -> NFA:
    """Renumber states to be sequential starting from q0."""
    # Collect all states in order, ensuring initial states come first
    seen: set[str] = set()
    ordered: list[str] = []

    for s in nfa.initial_states:
        if s not in seen:
            ordered.append(s)
            seen.add(s)

    for s in nfa.states:
        if s not in seen:
            ordered.append(s)
            seen.add(s)

    mapping = {old: _make_state(i) for i, old in enumerate(ordered)}

    return NFA(
        states=[mapping[s] for s in ordered],
        alphabets=set(nfa.alphabets),
        transitions=[
            [mapping[t[0]], t[1], mapping[t[2]]] for t in nfa.transitions
        ],
        initial_states=[mapping[s] for s in nfa.initial_states],
        final_states=[mapping[s] for s in nfa.final_states],
    )


def regex_to_automaton(regex: str, name: str, direction: str = "forward",
                       min_length: int | None = None,
                       max_length: int | None = None) -> dict:
    """Convert a regex pattern to the engine automaton JSON format.

    Args:
        regex: Regex pattern (e.g. "KNOWS*", "LIKES/REPLY_OF*").
        name: Automaton name (e.g. "P1").
        direction: "forward" for LABEL- suffix, "reverse" for -LABEL prefix.
        min_length: Optional minimum path length constraint.
        max_length: Optional maximum path length constraint.

    Returns:
        Dict matching the engine automaton JSON format with keys:
        regular_expression, states, alphabets, transitions,
        initial_states, final_states, and optionally min_length/max_length.
    """
    tokens = _tokenize(regex)
    nfa, pos = _parse_regex(tokens)
    if pos < len(tokens):
        raise ValueError(f"Unexpected token at position {pos}: {tokens[pos]}")

    nfa = _normalize_nfa(nfa)

    # Apply direction to transitions if needed
    if direction == "reverse":
        new_transitions = []
        for t in nfa.transitions:
            label_dir = t[1]
            # Replace LABEL- with -LABEL
            if label_dir.endswith("-"):
                label = label_dir[:-1]
                new_transitions.append([t[0], f"-{label}", t[2]])
            else:
                new_transitions.append(t)
        nfa.transitions = new_transitions

    result: dict = {
        "regular_expression": regex,
        "states": nfa.states,
        "alphabets": sorted(nfa.alphabets),
        "transitions": nfa.transitions,
        "initial_states": nfa.initial_states,
        "final_states": nfa.final_states,
    }

    if min_length is not None:
        result["min_length"] = min_length
    if max_length is not None:
        result["max_length"] = max_length

    return result


def build_query_json(
    vertices: list[str],
    edges: list[str],
    automata: dict[str, dict],
    we_constraints: list[dict] | None = None,
) -> dict:
    """Build a complete engine query JSON from components.

    Args:
        vertices: List of vertex declarations (e.g. ["v1:Any", "v2:Person"]).
        edges: List of edge declarations (e.g. ["(v1)-[P1]->(v2)"]).
        automata: Dict mapping automaton name to automaton JSON dict.
        we_constraints: Optional list of word equality constraints, each with
            keys "path1", "path2", and "source_constraint".

    Returns:
        Complete query JSON dict ready to send to the engine.
    """
    query: dict = {
        "query_vertices": vertices,
        "query_edges": edges,
        "automata": automata,
    }
    if we_constraints:
        query["word_equality_constraints"] = we_constraints
    return query
