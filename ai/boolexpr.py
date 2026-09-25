"""
boolexpr.py - parse & evaluate boolean expressions in the course notation, to
build a DETERMINISTIC oracle from equations (independent of the gate netlist).

Notation (superset of what the labs/specs use):
  NOT : a'  |  ~a  |  not a          (postfix ' or prefix ~ / not)
  AND : a*b |  a and b |  a&b |  ab   (juxtaposition = AND)
  OR  : a+b |  a or b  |  a|b
  XOR : a^b |  a xor b
  parens ( )   ; constants 0 / 1
Precedence (low->high): OR < XOR < AND < NOT < postfix(').

Used by pipeline oracle_from_equations(): different representation than the
netlist, so cross-checking catches wiring/logic hallucinations.
"""
from __future__ import annotations
import re
from itertools import product

_TOKEN = re.compile(r"\s*(xnor\b|nand\b|nor\b|and\b|or\b|xor\b|not\b|[A-Za-z_]\w*|[01]|[()~*&|+^'])", re.I)


def tokenize(s: str):
    toks, i = [], 0
    while i < len(s):
        m = _TOKEN.match(s, i)
        if not m:
            if s[i].isspace():
                i += 1
                continue
            raise ValueError(f"bad char {s[i]!r} at {i} in {s!r}")
        toks.append(m.group(1))
        i = m.end()
    return toks


class _P:
    def __init__(self, toks):
        self.t = toks
        self.i = 0

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else None

    def eat(self):
        tok = self.t[self.i]
        self.i += 1
        return tok

    def _starts_factor(self, tok):
        return tok is not None and (tok not in (")", "*", "&", "+", "|", "^",
                                                "and", "or", "xor", "nand", "nor", "xnor", "'"))

    def parse(self):
        node = self.p_or()
        if self.i != len(self.t):
            raise ValueError("trailing tokens: " + " ".join(self.t[self.i:]))
        return node

    def p_or(self):
        n = self.p_xor()
        while True:
            t = self.peek()
            if t in ("+", "|") or (t and t.lower() == "or"):
                self.eat(); n = ("or", n, self.p_xor())
            elif t and t.lower() == "nor":                     # a nor b = (a or b)'
                self.eat(); n = ("not", ("or", n, self.p_xor()))
            else:
                break
        return n

    def p_xor(self):
        n = self.p_and()
        while True:
            t = self.peek()
            if t == "^" or (t and t.lower() == "xor"):
                self.eat(); n = ("xor", n, self.p_and())
            elif t and t.lower() == "xnor":                    # a xnor b = (a xor b)'
                self.eat(); n = ("not", ("xor", n, self.p_and()))
            else:
                break
        return n

    def p_and(self):
        n = self.p_not()
        while True:
            t = self.peek()
            if t in ("*", "&") or (t and t.lower() == "and"):
                self.eat()
                n = ("and", n, self.p_not())
            elif t and t.lower() == "nand":                    # a nand b = (a and b)'
                self.eat(); n = ("not", ("and", n, self.p_not()))
            elif self._starts_factor(t):        # implicit AND (juxtaposition)
                n = ("and", n, self.p_not())
            else:
                break
        return n

    def p_not(self):
        t = self.peek()
        if t == "~" or (t and t.lower() == "not"):
            self.eat()
            return ("not", self.p_not())
        return self.p_post()

    def p_post(self):
        n = self.p_atom()
        while self.peek() == "'":
            self.eat()
            n = ("not", n)
        return n

    def p_atom(self):
        t = self.eat()
        if t == "(":
            n = self.p_or()
            if self.eat() != ")":
                raise ValueError("expected )")
            return n
        if t in ("0", "1"):
            return ("const", int(t))
        if re.match(r"[A-Za-z_]\w*$", t):
            return ("var", t)
        raise ValueError("unexpected token " + repr(t))


def parse(expr: str):
    return _P(tokenize(expr)).parse()


def eval_node(node, env: dict) -> int:
    op = node[0]
    if op == "var":
        return env[node[1]] & 1
    if op == "const":
        return node[1] & 1
    if op == "not":
        return eval_node(node[1], env) ^ 1
    a = eval_node(node[1], env)
    b = eval_node(node[2], env)
    if op == "and":
        return a & b
    if op == "or":
        return a | b
    if op == "xor":
        return a ^ b
    raise ValueError("bad node " + str(op))


def variables(node, acc=None):
    acc = set() if acc is None else acc
    if node[0] == "var":
        acc.add(node[1])
    elif node[0] in ("not",):
        variables(node[1], acc)
    elif node[0] in ("and", "or", "xor"):
        variables(node[1], acc)
        variables(node[2], acc)
    return acc


def truth_table(exprs: dict, inputs: list[str] | None = None):
    """exprs: {out_name: expr_str}. Returns (inputs, outputs, rows{in_tuple:out_tuple})."""
    trees = {o: parse(e) for o, e in exprs.items()}
    if inputs is None:
        vs = set()
        for t in trees.values():
            variables(t, vs)
        inputs = sorted(vs)
    outputs = list(exprs.keys())
    rows = {}
    for bits in product((0, 1), repeat=len(inputs)):
        env = dict(zip(inputs, bits))
        rows[bits] = tuple(eval_node(trees[o], env) for o in outputs)
    return inputs, outputs, rows


if __name__ == "__main__":
    import sys
    # quick demo: boolexpr.py "sum=a^b^cin" "cout=a*b+(a^b)*cin"
    exprs = dict(kv.split("=", 1) for kv in sys.argv[1:])
    ins, outs, rows = truth_table(exprs)
    print("inputs:", ins, "outputs:", outs)
    for bits, ob in sorted(rows.items()):
        print(" ".join(map(str, bits)), "->", " ".join(map(str, ob)))
