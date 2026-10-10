"""CleverCalculator headless JSONL adapter. No GUI imports or Python evaluation.

Vendored worker and three pure engines from CleverCalculator. On 2026-10-10,
the owner confirmed ownership of this unpublished project and explicitly authorized
public release of the integrated sources and binaries. No permissive project license
is inferred or assigned; the host MIT license does not cover this source.
Python/SymPy/mpmath retain their respective licenses and notices.
"""
from __future__ import annotations

import ast
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import threading

ROOT = Path(__file__).resolve().parent
MAX_LINE = 16384
MAX_TEXT = 2048
MAX_OUTPUT = 65536
TIMEOUT = 12


class InputError(ValueError):
    pass


def load_engines():
    engines = {}
    for mode, relative in {
        "calculus": "Calculus/calculus/engine.py",
        "matrix": "Matrix/matrix/engine.py",
        "ode": "DifferentialEquation/differential_equation/engine.py",
    }.items():
        spec = importlib.util.spec_from_file_location("clever_headless_" + mode, ROOT / relative)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        # Legacy parse_expr uses eval with SymPy's entire namespace. Replace it
        # only inside these adapter-owned modules with a small AST interpreter.
        module.parse_expr = safe_parse
        module.sympify = lambda text, locals=None: safe_parse(str(text), local_dict=locals)
        engines[mode] = module
    return engines


def safe_parse(text, local_dict=None, transformations=None, **_):
    import sympy as sp
    from sympy.parsing.sympy_parser import stringify_expr, standard_transformations
    names = {name: getattr(sp, name) for name in (
        "Symbol", "Integer", "Float", "Rational", "sin", "cos", "tan", "asin",
        "acos", "atan", "sinh", "cosh", "tanh", "sec", "csc", "cot", "exp",
        "log", "sqrt", "Abs", "factorial", "Derivative", "Matrix",
    )}
    names.update(pi=sp.pi, E=sp.E, I=sp.I, oo=sp.oo)
    local = dict(local_dict or {})
    source = stringify_expr(text, local, names, transformations or standard_transformations)
    tree = ast.parse(source, mode="eval")
    if sum(1 for _ in ast.walk(tree)) > 1024:
        raise InputError("Expression is too complex")

    def visit(node, depth=0):
        if depth > 32:
            raise InputError("Expression nesting exceeds 32")
        v = lambda n: visit(n, depth + 1)
        if isinstance(node, ast.Constant) and type(node.value) in (int, float, str):
            if isinstance(node.value, str) and len(node.value) > 64:
                raise InputError("Token is too long")
            return node.value
        if isinstance(node, ast.Name) and node.id in {**names, **local}:
            return local.get(node.id, names.get(node.id))
        if isinstance(node, (ast.List, ast.Tuple)):
            if len(node.elts) > 64:
                raise InputError("List exceeds 64 entries")
            return [v(n) for n in node.elts]
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = v(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp):
            left, right = v(node.left), v(node.right)
            if isinstance(node.op, ast.Add): return left + right
            if isinstance(node.op, ast.Sub): return left - right
            if isinstance(node.op, ast.Mult): return left * right
            if isinstance(node.op, ast.Div): return left / right
            if isinstance(node.op, ast.Pow):
                if getattr(right, "is_number", isinstance(right, (int, float))) and abs(right) > 100:
                    raise InputError("Exponent exceeds 100")
                return left ** right
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            name = node.func.id
            fn = local.get(name, names.get(name))
            if not callable(fn) or len(node.args) > 12:
                raise InputError("Unsupported mathematical function")
            args = [v(n) for n in node.args]
            if name == "Matrix" and (len(args) != 1 or not isinstance(args[0], list)
                    or len(args[0]) > 8 or any(not isinstance(r, list) or len(r) > 8 for r in args[0])):
                raise InputError("Matrices are limited to 8 by 8")
            if name in ("factorial", "Derivative") and any(getattr(a, "is_Integer", False) and abs(a) > 100 for a in args):
                raise InputError("Order exceeds 100")
            return fn(*args)
        raise InputError("Only mathematical expressions are supported")

    return visit(tree.body)


def validate_text(value):
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_TEXT:
        raise InputError("Expression must contain 1–2048 characters")
    if "__" in value or re.search(r"[A-Za-z]\s*\.|\.[A-Za-z]|[\";:`\\]", value):
        raise InputError("Python syntax is not supported")
    if re.search(r"\d{9,}", value):
        raise InputError("Numeric tokens are limited to 8 digits")
    return value


def process(request, engines):
    if not isinstance(request, dict):
        raise InputError("Request must be an object")
    if set(request) - {"id", "mode", "expression", "conditions"}:
        raise InputError("Unknown request fields")
    mode = request.get("mode")
    if mode not in engines:
        raise InputError("Mode must be calculus, matrix or ode")
    raw = validate_text(request.get("expression"))
    conditions = request.get("conditions", [])
    if not isinstance(conditions, list) or len(conditions) > 8:
        raise InputError("At most 8 conditions are supported")
    for condition in conditions:
        validate_text(condition)
    if mode != "ode" and conditions:
        raise InputError("Conditions are only supported for ODE")
    engine = engines[mode]
    result = engine.compute(raw, conditions) if mode == "ode" else engine.compute(raw)
    if mode == "matrix":
        return {"text": result.text, "latex": None, "kind": result.kind,
                "isMatrix": result.is_matrix, "matrixText": result.matrix_text,
                "label": result.label}
    # Capture the actual SymPy result before formatting; never reparse output.
    return {"text": result, "latex": getattr(engine, "_last_latex", None) if mode == "calculus" else None}


def emit(value):
    line = json.dumps(value, ensure_ascii=False)
    if len(line.encode("utf-8")) > MAX_OUTPUT:
        line = json.dumps({"id": value.get("id"), "ok": False,
                           "error": {"code": "OUTPUT_LIMIT", "message": "Result exceeds output limit"}})
    print(line, flush=True)


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    with contextlib.redirect_stdout(sys.stderr):
        engines = load_engines()
        import sympy
        original = engines["calculus"]._format_result
        def formatted(expr):
            engines["calculus"]._last_latex = sympy.latex(expr)
            return original(expr)
        engines["calculus"]._format_result = formatted
    emit({"type": "ready", "protocol": 1, "modes": list(engines)})
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE + 1)
        if not line:
            return
        if len(line) > MAX_LINE:
            emit({"id": None, "ok": False, "error": {"code": "INPUT_LIMIT", "message": "JSON line exceeds 16 KiB"}})
            return  # don't accumulate/discard an unbounded stream
        request_id = None
        timer = None
        try:
            request = json.loads(line)
            request_id = request.get("id") if isinstance(request, dict) else None
            if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", request_id):
                request_id = None
                raise InputError("A valid request ID is required")
            def expired():
                emit({"id": request_id, "ok": False, "error": {"code": "TIMEOUT", "message": "Calculation exceeded 12 seconds"}})
                os._exit(124)  # stop computation; next request starts a fresh worker
            timer = threading.Timer(TIMEOUT, expired)
            timer.daemon = True
            timer.start()
            with contextlib.redirect_stdout(sys.stderr):
                result = process(request, engines)
            timer.cancel()
            emit({"id": request_id, "ok": True, "result": result})
        except Exception as exc:
            if timer: timer.cancel()
            emit({"id": request_id, "ok": False, "error": {
                "code": "INVALID_INPUT" if isinstance(exc, (InputError, json.JSONDecodeError)) else "CALCULATION_ERROR",
                "message": (str(exc) or "Expression could not be solved")[:500]}})
        finally:
            if timer: timer.cancel()


if __name__ == "__main__":
    sys.exit(main())
