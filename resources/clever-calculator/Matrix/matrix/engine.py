"""矩阵计算引擎:清洗 / 解析 / 矩阵运算 / 初等变换 / 判断类操作 / 化简。

标记语法(用户可手输,UI 也会自动生成):
  矩阵字面量    [[1, 2], [3, 4]]
  符号矩阵      A B C D(任意矩阵);常数 a b c k α β
  行列式        det(A) 或 |A|
  转置          transpose(A)      求逆  inverse(A)
  伴随          adjugate(A)       秩    rank(A)
  迹            trace(A)          对角化 diag(A)
  特征值        eigenval(A)       特征向量 eigenvect(A)
  余子式        minor(A, i, j)    代数余子式 cofactor(A, i, j)
  顺序主子式    leading_minor(A, k)
  行阶梯形      echelon(A)        行最简形 rref(A)
  二次型        quadratic(A)      标准形 standard(A)  规范形 normal(A)
  初等变换(结果替换输入):
    swap(A, i, j)   / swapc(A, i, j)      交换两行/两列
    mulrow(A, i, k) / mulcol(A, i, k)     某行/列乘 k
    addrow(A, i, k, j) / addcol(A, i, k, j)  ri + k*rj
  判断类(输出可逆/对称/…):
    invertible / symmetric / orthogonal / posdef / dependent
    equivalent(A, B) / similar(A, B) / congruent(A, B)   (也支持 A≅B A~B A≃B)
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from sympy import (
    Abs, Determinant, I, Integer, Inverse, Matrix, MatrixBase, MatrixExpr,
    MatrixSymbol, N, Symbol, Trace, expand, eye, nan, oo, simplify, sqrt,
    symbols, zeros,
)
from sympy.parsing.sympy_parser import (
    implicit_multiplication_application, parse_expr, standard_transformations,
)

# ---------------------------------------------------------------- 异常

class CalcError(Exception):
    """格式错误:返回"表达式格式不正确: ..."消息。"""


class TooComplexError(Exception):
    """无法求出:返回"表达式过于复杂, 无法求出!"消息。"""


# ---------------------------------------------------------------- 符号环境

_N, _M = symbols("n m", positive=True, integer=True)
_MATRIX_VARS = {ch: MatrixSymbol(ch, _N, _M) for ch in "ABCD"}
_CONST_VARS = {
    "a": Symbol("a"), "b": Symbol("b"), "c": Symbol("c"), "k": Symbol("k"),
    "alpha": Symbol("alpha"), "beta": Symbol("beta"),
}
_LOCAL = dict(_MATRIX_VARS)
_LOCAL.update(_CONST_VARS)
_LOCAL["pi"] = Symbol("pi", positive=True)
_LOCAL["e"] = Symbol("e", positive=True)

_TRANSFORMS = standard_transformations + (implicit_multiplication_application,)

_ALLOWED_RE = re.compile(r"^[0-9A-Za-z_\s+\-*/^%(),.\[\]]+$")


class _TextResult:
    """封装多行说明文本(特征值/对角化/标准形等)的结果。"""

    def __init__(self, text: str):
        self.text = text

    def __str__(self) -> str:
        return self.text


@dataclass
class CalcResult:
    """引擎返回值。

    kind: normal(基本运算/化简,用 = ) | transform(初等变换,用 →) | judge(判断,用 →)
    label: 变换/判断的箭头标签(LaTeX 或中文)
    text: 展示文本;is_matrix/matrix_text: 矩阵结果
    judge_result: 判断结果文本("可逆"/"等价"…)
    """
    text: str = ""
    kind: str = "normal"
    label: str = ""
    is_matrix: bool = False
    matrix_text: str = ""
    judge_result: str = ""


# ---------------------------------------------------------------- 输入清洗

_PLACEHOLDER_RE = re.compile(r"〔[^〕]*〕")
_MATRIX_LIT_RE = re.compile(r"\[\[.*?\]\]", re.DOTALL)


def _check_placeholders(s: str) -> None:
    if "〔" in s or "〕" in s:
        missing = [m.group(0).strip("〔〕") for m in _PLACEHOLDER_RE.finditer(s)]
        if missing:
            raise CalcError("缺少" + "、".join(missing[:3]) + ("" if len(missing) <= 3 else " 等"))
        raise CalcError("输入含有未填写的占位符")


def _replace_top_rel(s: str, sym: str, fn: str) -> str:
    """把最外层(括号外)的关系符号替换为 fn(左, 右)。"""
    depth = 0
    for i, ch in enumerate(s):
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == sym and depth == 0:
            return f"{fn}({s[:i]}, {s[i + len(sym):]})"
    return s


def _check_brackets(s: str) -> None:
    depth = 0
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth < 0:
                raise CalcError("括号不全, 请检查是否有多余的右括号")
    if depth > 0:
        raise CalcError("括号不全, 缺少右括号")


def _clean(raw: str) -> str:
    s = raw.strip().replace("\n", "").replace("\r", "")
    if not s:
        raise CalcError("表达式为空")
    if "〔" in s or "〕" in s:
        _check_placeholders(s)
    # 1) 提取矩阵字面量 [[...]] -> token(避免被括号统一破坏)
    tokens: dict[str, str] = {}

    def _sub(m: re.Match) -> str:
        tok = f"__MTX{len(tokens)}__"
        tokens[tok] = m.group(0)
        return tok

    s = _MATRIX_LIT_RE.sub(_sub, s)
    # 2) |...| -> det(...)(循环处理嵌套)
    for _ in range(8):
        new = re.sub(r"\|([^|]+)\|", r"det(\1)", s)
        if new == s:
            break
        s = new
    if "|" in s:
        raise CalcError("绝对值符号 | 不配对")
    # 3) 顶层关系符号 A≅B / A~B / A≃B
    s = _replace_top_rel(s, "≅", "equivalent")
    s = _replace_top_rel(s, "≃", "congruent")
    s = _replace_top_rel(s, "~", "similar")
    # 4) 括号统一 + 运算符别名
    s = s.replace("[", "(").replace("]", ")").replace("{", "(").replace("}", ")")
    s = s.replace("（", "(").replace("）", ")")
    s = s.replace("×", "*").replace("·", "*").replace("÷", "/").replace("^", "**")
    s = s.replace("π", "pi").replace("θ", "theta").replace("φ", "phi")
    s = s.replace("Φ", "Phi").replace("α", "alpha").replace("β", "beta")
    s = s.replace("λ", "lambda")
    # 5) 函数名后紧跟字母/数字(无括号)自动补括号
    s = re.sub(
        r"(?<![A-Za-z_])(sinh|cosh|tanh|asin|acos|atan|csc|sec|cot|"
        r"sin|cos|tan|ln|lg|exp|sqrt|abs|log)\s*"
        r"([A-Za-z][A-Za-z0-9]*|[0-9]+)",
        r"\1(\2)", s)
    # 6) 还原矩阵字面量
    for tok, body in tokens.items():
        s = s.replace(tok, "Matrix(" + body + ")")
    _check_brackets(s)
    # 7) 白名单
    if not _ALLOWED_RE.match(s):
        bad = sorted({c for c in s if not _ALLOWED_RE.match(c)})
        raise CalcError("表达式包含不支持的字符: " + " ".join(repr(c) for c in bad[:5]))
    return s


# ---------------------------------------------------------------- 解析求值

def _split_top(s: str) -> list[str]:
    parts, depth, cur = [], 0, ""
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur.strip())
            cur = ""
        else:
            cur += ch
    parts.append(cur.strip())
    return parts


def _match_paren(s: str, start: int) -> int:
    depth = 0
    for i in range(start, len(s)):
        if s[i] == "(":
            depth += 1
        elif s[i] == ")":
            depth -= 1
            if depth == 0:
                return i
    raise CalcError("括号不全")


def _eval_text(s: str):
    """把一段清洗后的文本解析为 sympy 对象。"""
    s = s.strip()
    if not s:
        return None
    try:
        return parse_expr(s, local_dict=_LOCAL, transformations=_TRANSFORMS)
    except CalcError:
        raise
    except Exception as exc:
        raise CalcError(f"无法识别的表达式: {s!r} ({exc})") from exc


# ---------------------------------------------------------------- 矩阵工具

def _as_matrix(x, what: str = "该操作"):
    """把参数转为具体 sympy Matrix;符号矩阵/非矩阵抛 CalcError。"""
    if isinstance(x, MatrixBase):
        return x
    if isinstance(x, MatrixExpr):
        raise CalcError(f"{what}需要具体的数值矩阵, 请先用左边栏生成矩阵并填入数字")
    raise CalcError(f"{what}的参数不是矩阵: {x!r}")


def _need_num_matrix(x, what: str = "该操作") -> Matrix:
    m = _as_matrix(x, what)
    for e in m:
        if e.free_symbols and not e.is_number:
            raise CalcError(f"{what}需要数值矩阵, 请先填入数字(当前含符号 {e})")
    return m


def _matrix_to_text(m) -> str:
    rows = []
    for r in range(m.rows):
        rows.append("[" + ", ".join(str(simplify(m[r, c])) for c in range(m.cols)) + "]")
    return "[" + ", ".join(rows) + "]"


def _fmt_n(n) -> str:
    """化简数字(去掉 .0 / 符号)。"""
    try:
        v = N(n)
        if v.is_Integer:
            return str(int(v))
        if v.is_Rational:
            return str(v)
        return str(v)
    except Exception:
        return str(n)


def _as_int(v, what: str = "下标") -> int:
    """把参数转为 Python int; 非整数(如 1.5 / 符号)报错而不是静默截断。"""
    try:
        is_int = bool(v.is_integer)
    except AttributeError:
        is_int = isinstance(v, int)
    if not is_int:
        raise CalcError(f"{what}应为整数, 而不是 {v!r}")
    return int(v)


# ---------------------------------------------------------------- 操作函数(local_dict 用)

def _f_det(x):
    if isinstance(x, MatrixBase):
        return x.det()
    if isinstance(x, MatrixExpr):
        return Determinant(x)
    return Abs(x)  # |标量| 视为绝对值


def _f_transpose(x):
    return x.T


def _f_inverse(x):
    if isinstance(x, MatrixBase):
        if x.det() == 0:
            raise CalcError("矩阵不可逆(行列式为 0)")
        return x.inv()
    if isinstance(x, MatrixExpr):
        return Inverse(x)
    raise CalcError("求逆参数不是矩阵")


def _f_adjugate(x):
    if isinstance(x, MatrixBase):
        return x.adjugate()
    raise CalcError("伴随矩阵需要具体的数值矩阵")


def _f_rank(x):
    if isinstance(x, MatrixBase):
        return x.rank()
    raise CalcError("求秩需要具体的数值矩阵")


def _f_trace(x):
    if isinstance(x, MatrixBase):
        return x.trace()
    if isinstance(x, MatrixExpr):
        return Trace(x)
    raise CalcError("求迹参数不是矩阵")


def _f_minor(x, i, j):
    m = _as_matrix(x, "求余子式")
    i, j = _as_int(i, "行 i"), _as_int(j, "列 j")
    if not (1 <= i <= m.rows and 1 <= j <= m.cols):
        raise CalcError(f"余子式位置越界: 矩阵为 {m.rows}×{m.cols}, 而输入为 ({i}, {j})")
    return m.minor(i - 1, j - 1)


def _f_cofactor(x, i, j):
    m = _as_matrix(x, "求代数余子式")
    i, j = _as_int(i, "行 i"), _as_int(j, "列 j")
    if not (1 <= i <= m.rows and 1 <= j <= m.cols):
        raise CalcError(f"代数余子式位置越界: 矩阵为 {m.rows}×{m.cols}, 而输入为 ({i}, {j})")
    return m.cofactor(i - 1, j - 1)


def _f_leading_minor(x, k):
    m = _as_matrix(x, "求顺序主子式")
    k = _as_int(k, "阶数 k")
    if not (1 <= k <= min(m.rows, m.cols)):
        raise CalcError(f"顺序主子式的阶数越界: 应为 1~{min(m.rows, m.cols)}")
    return m[:k, :k].det()


def _f_echelon(x):
    return _as_matrix(x, "行阶梯形").echelon_form()


def _f_rref(x):
    return _as_matrix(x, "行最简形").rref()[0]


def _f_diag(x):
    m = _as_matrix(x, "对角化")
    if m.rows != m.cols:
        raise CalcError("只有方阵才能对角化")
    try:
        P, D = m.diagonalize()
    except Exception as exc:
        raise CalcError("矩阵不可对角化(特征值缺失或几何重数不足)") from exc
    return _TextResult(
        "对角化: A = P·D·P⁻¹\nP = " + _matrix_to_text(P) + "\nD = " + _matrix_to_text(D))


def _f_eigenval(x):
    m = _need_num_matrix(x, "求特征值")
    if m.rows != m.cols:
        raise CalcError("只有方阵才有特征值")
    ev = m.eigenvals()
    parts = []
    for lam, mult in ev.items():
        parts.append(f"λ = {lam}" + (f"(重数 {mult})" if mult > 1 else ""))
    return _TextResult("特征值: " + " ;  ".join(parts))


def _f_eigenvect(x):
    m = _need_num_matrix(x, "求特征向量")
    if m.rows != m.cols:
        raise CalcError("只有方阵才有特征向量")
    try:
        evs = m.eigenvects()
    except Exception as exc:
        raise CalcError("特征向量计算失败(矩阵不可对角化或过于复杂)") from exc
    lines = []
    for lam, mult, vecs in evs:
        head = f"λ = {lam}" + (f"(重数 {mult})" if mult > 1 else "")
        vec_str = " ;  ".join(_matrix_to_text(v) for v in vecs)
        lines.append(f"{head}: 特征向量 {vec_str}")
    return _TextResult("\n".join(lines) if lines else "无特征向量")


def _f_quadratic(x):
    m = _as_matrix(x, "二次型")
    if m.rows != m.cols:
        raise CalcError("二次型需要方阵")
    n = m.rows
    S = simplify((m + m.T) / 2)
    xs = symbols(f"x1:{n + 1}")
    expr = sum(S[i, i] * xs[i] ** 2 for i in range(n))
    expr += sum(2 * S[i, j] * xs[i] * xs[j]
                for i in range(n) for j in range(i + 1, n))
    return expand(simplify(expr))


def _congruence_diag(m: Matrix):
    """合同对角化:返回 (P, D) 使 Pᵀ·m·P = D,D 为对角矩阵(Gauss 消元)。"""
    n = m.rows
    A = m.as_mutable()
    P = eye(n).as_mutable()
    k = 0
    while k < n:
        if simplify(A[k, k]) != 0:
            for i in range(k + 1, n):
                if simplify(A[i, k]) != 0:
                    c = simplify(A[i, k] / A[k, k])
                    E = eye(n).as_mutable()
                    E[i, k] = -c
                    A = simplify(E.T * A * E)
                    P = simplify(P * E)
        else:
            p = next((i for i in range(k + 1, n) if simplify(A[i, i]) != 0), None)
            if p is not None:
                E = eye(n).as_mutable()
                E[k, k] = 0
                E[p, p] = 0
                E[k, p] = 1
                E[p, k] = 1
                A = simplify(E.T * A * E)
                P = simplify(P * E)
                continue
            q = next((i for i in range(k + 1, n) if simplify(A[k, i]) != 0), None)
            if q is not None:
                E = eye(n).as_mutable()
                E[k, k] = 1
                E[k, q] = 1
                E[q, k] = 1
                E[q, q] = -1
                A = simplify(E.T * A * E)
                P = simplify(P * E)
                continue
            break
        k += 1
    return P, A


def _f_standard(x):
    m = _as_matrix(x, "标准形")
    if m.rows != m.cols:
        raise CalcError("标准形需要方阵")
    S = simplify((m + m.T) / 2)
    P, D = _congruence_diag(S)
    n = S.rows
    ys = symbols(f"y1:{n + 1}")
    terms = [simplify(D[i, i]) * ys[i] ** 2 for i in range(n) if simplify(D[i, i]) != 0]
    form = " + ".join(str(t) for t in terms) if terms else "0"
    return _TextResult(
        "标准形(经合同变换 x = P·y, 即 PᵀAP = D):\n"
        f"二次型 = {form}\n"
        "P = " + _matrix_to_text(P) + "\nD = " + _matrix_to_text(D))


def _f_normal(x):
    m = _need_num_matrix(x, "规范形")
    if m.rows != m.cols:
        raise CalcError("规范形需要方阵")
    S = simplify((m + m.T) / 2)
    P, D = _congruence_diag(S)
    signs = []
    for i in range(S.rows):
        d = N(D[i, i])
        if d > 0:
            signs.append("1")
        elif d < 0:
            signs.append("-1")
        else:
            signs.append("0")
    n = S.rows
    ys = symbols(f"y1:{n + 1}")
    terms = [signs[i] + "*" + str(ys[i]) + "**2" if signs[i] != "0" else None
             for i in range(n)]
    terms = [t for t in terms if t]
    form = " + ".join(terms) if terms else "0"
    pos = signs.count("1")
    neg = signs.count("-1")
    return _TextResult(
        "规范形(惯性指数: 正惯性 " + str(pos) + ", 负惯性 " + str(neg) + "):\n"
        f"二次型 = {form}")


# 判断类
def _is_symmetric(m: Matrix) -> bool:
    """精确判断方阵是否对称，避免依赖 SymPy 的布尔矩阵比较。"""
    return m.rows == m.cols and all(simplify(m[i, j] - m[j, i]) == 0
                                    for i in range(m.rows)
                                    for j in range(m.cols))


def _is_real_symmetric(m: Matrix) -> bool:
    """判断是否为实对称矩阵，正定和实合同判定均要求此条件。"""
    return _is_symmetric(m) and all(value.is_real is True for value in m)


def _f_invertible(x):
    m = _need_num_matrix(x, "判断可逆性")
    if m.rows != m.cols:
        return "不可逆(非方阵无逆矩阵)"
    return "可逆" if m.det() != 0 else "不可逆"


def _f_symmetric(x):
    m = _need_num_matrix(x, "判断对称性")
    if m.rows != m.cols:
        return "不对称(非方阵)"
    if _is_symmetric(m):
        return "对称矩阵"
    if all(simplify(m[i, j] + m[j, i]) == 0
           for i in range(m.rows) for j in range(m.cols)):
        return "反对称矩阵"
    return "不对称矩阵"


def _f_orthogonal(x):
    m = _need_num_matrix(x, "判断正交性")
    if m.rows != m.cols:
        return "不正交(非方阵)"
    prod = simplify(m.T * m)
    if prod == eye(m.rows):
        return "正交矩阵"
    return "不正交"


def _f_posdef(x):
    m = _need_num_matrix(x, "判断正定性")
    if m.rows != m.cols:
        return "不正定(非方阵)"
    if not _is_real_symmetric(m):
        return "不正定(非实对称矩阵)"
    try:
        evals = [N(e) for e in m.eigenvals()]
    except Exception as exc:
        raise CalcError("正定性判断失败(矩阵含符号)") from exc
    if all(v > 0 for v in evals):
        return "正定矩阵"
    if all(v >= 0 for v in evals):
        return "半正定矩阵"
    return "不正定"


def _f_dependent(x):
    m = _need_num_matrix(x, "判断线性相关性")
    return "线性相关" if m.rank() < m.cols else "线性无关"


def _f_equivalent(a, b):
    ma = _need_num_matrix(a, "判断等价")
    mb = _need_num_matrix(b, "判断等价")
    if ma.rows != mb.rows or ma.cols != mb.cols:
        return "不等价(尺寸不同)"
    return "等价" if ma.rank() == mb.rank() else "不等价"


def _f_similar(a, b):
    ma = _need_num_matrix(a, "判断相似")
    mb = _need_num_matrix(b, "判断相似")
    if ma.rows != mb.rows or ma.cols != mb.cols:
        return "不相似(尺寸不同)"
    if ma.rows != ma.cols:
        return "不相似(非方阵)"
    if ma.charpoly().as_expr() != mb.charpoly().as_expr():
        return "不相似(特征多项式不同)"
    try:
        # jordan_form 返回 (P, J)，只能比较 J；P 取决于特征向量选取，
        # 同一相似类的 P 通常并不相同。
        ja = ma.jordan_form()[1]
        jb = mb.jordan_form()[1]
    except Exception as exc:
        raise CalcError("相似性判断失败(无法可靠计算约当标准形)") from exc
    return "相似" if ja == jb else "不相似"


def _f_congruent(a, b):
    ma = _need_num_matrix(a, "判断合同")
    mb = _need_num_matrix(b, "判断合同")
    if ma.rows != mb.rows or ma.cols != mb.cols:
        return "不合同(尺寸不同)"
    if ma.rows != ma.cols:
        return "不合同(非方阵)"
    if not _is_real_symmetric(ma) or not _is_real_symmetric(mb):
        raise CalcError("合同判断仅支持实对称矩阵")

    def _inertia(x):
        evals = x.eigenvals()
        positive = negative = 0
        for eigenvalue, multiplicity in evals.items():
            value = N(eigenvalue)
            if value > 0:
                positive += int(multiplicity)
            elif value < 0:
                negative += int(multiplicity)
            elif value == 0:
                continue
            else:
                raise ValueError("无法确定特征值符号")
        return positive, negative

    try:
        return "合同" if _inertia(ma) == _inertia(mb) else "不合同"
    except Exception as exc:
        raise CalcError("合同判断失败(矩阵含符号或无法确定特征值符号)") from exc


# 初等变换
def _row_check(m, i, j, what="行"):
    if not (1 <= i <= m.rows and 1 <= j <= m.rows):
        raise CalcError(f"{what}下标越界: 矩阵有 {m.rows} 行, 输入为 ({i}, {j})")


def _f_swap(m, i, j):
    m = _as_matrix(m, "交换行")
    i, j = _as_int(i, "行下标"), _as_int(j, "行下标")
    _row_check(m, i, j)
    out = m.as_mutable()
    out.row_swap(i - 1, j - 1)
    return out, f"r_{i} \\leftrightarrow r_{j}"


def _fmt_k(kk) -> str:
    """k 的具体数值文本(符号保持 k, 分数/负数原样显示)。"""
    kk = simplify(kk)
    return str(kk)


def _label_mul(i, k, row: bool = True) -> str:
    """ri × k 标签, 显示 k 的具体数值(如 r_2 \times 3)。"""
    r = "r" if row else "c"
    return f"{r}_{i} \\times {_fmt_k(k)}"


def _label_add(i, j, k, row: bool = True) -> str:
    """ri + k rj 标签, 显示 k 的具体数值(负数自动转为减号)。"""
    r = "r" if row else "c"
    kk = simplify(k)
    try:
        if kk.is_negative:
            return f"{r}_{i} - {_fmt_k(-kk)} \\, {r}_{j}"
    except Exception:
        pass
    return f"{r}_{i} + {_fmt_k(kk)} \\, {r}_{j}"


def _f_swapc(m, i, j):
    m = _as_matrix(m, "交换列")
    i, j = _as_int(i, "列下标"), _as_int(j, "列下标")
    if not (1 <= i <= m.cols and 1 <= j <= m.cols):
        raise CalcError(f"列下标越界: 矩阵有 {m.cols} 列, 输入为 ({i}, {j})")
    out = m.as_mutable()
    out.col_swap(i - 1, j - 1)
    return out, f"c_{i} \\leftrightarrow c_{j}"


def _f_mulrow(m, i, k):
    m = _as_matrix(m, "行乘常数")
    i = _as_int(i, "行下标")
    if not (1 <= i <= m.rows):
        raise CalcError(f"行下标越界: 矩阵有 {m.rows} 行, 输入为 {i}")
    kk = simplify(k)
    if kk == 0:
        raise CalcError("×k 的常数 k 不能为 0")
    out = m.as_mutable()
    for c in range(m.cols):
        out[i - 1, c] = simplify(kk * out[i - 1, c])
    return out, _label_mul(i, kk)


def _f_mulcol(m, i, k):
    m = _as_matrix(m, "列乘常数")
    i = _as_int(i, "列下标")
    if not (1 <= i <= m.cols):
        raise CalcError(f"列下标越界: 矩阵有 {m.cols} 列, 输入为 {i}")
    kk = simplify(k)
    if kk == 0:
        raise CalcError("×k 的常数 k 不能为 0")
    out = m.as_mutable()
    for r in range(m.rows):
        out[r, i - 1] = simplify(kk * out[r, i - 1])
    return out, _label_mul(i, kk, row=False)


def _f_addrow(m, i, k, j):
    m = _as_matrix(m, "行加 k 倍")
    i, j = _as_int(i, "行下标"), _as_int(j, "行下标")
    _row_check(m, i, j)
    kk = simplify(k)
    out = m.as_mutable()
    for c in range(m.cols):
        out[i - 1, c] = simplify(out[i - 1, c] + kk * out[j - 1, c])
    return out, _label_add(i, j, kk)


def _f_addcol(m, i, k, j):
    m = _as_matrix(m, "列加 k 倍")
    i, j = _as_int(i, "列下标"), _as_int(j, "列下标")
    if not (1 <= i <= m.cols and 1 <= j <= m.cols):
        raise CalcError(f"列下标越界: 矩阵有 {m.cols} 列, 输入为 ({i}, {j})")
    kk = simplify(k)
    out = m.as_mutable()
    for r in range(m.rows):
        out[r, i - 1] = simplify(out[r, i - 1] + kk * out[r, j - 1])
    return out, _label_add(i, j, kk, row=False)


# 填充 local_dict
_LOCAL["Matrix"] = Matrix
_LOCAL["det"] = _f_det
_LOCAL["transpose"] = _f_transpose
_LOCAL["inverse"] = _f_inverse
_LOCAL["adjugate"] = _f_adjugate
_LOCAL["rank"] = _f_rank
_LOCAL["trace"] = _f_trace
_LOCAL["diag"] = _f_diag
_LOCAL["eigenval"] = _f_eigenval
_LOCAL["eigenvect"] = _f_eigenvect
_LOCAL["minor"] = _f_minor
_LOCAL["cofactor"] = _f_cofactor
_LOCAL["leading_minor"] = _f_leading_minor
_LOCAL["echelon"] = _f_echelon
_LOCAL["rref"] = _f_rref
_LOCAL["quadratic"] = _f_quadratic
_LOCAL["standard"] = _f_standard
_LOCAL["normal"] = _f_normal
_LOCAL["invertible"] = _f_invertible
_LOCAL["symmetric"] = _f_symmetric
_LOCAL["orthogonal"] = _f_orthogonal
_LOCAL["posdef"] = _f_posdef
_LOCAL["dependent"] = _f_dependent
_LOCAL["equivalent"] = _f_equivalent
_LOCAL["similar"] = _f_similar
_LOCAL["congruent"] = _f_congruent
_LOCAL["swap"] = _f_swap
_LOCAL["swapc"] = _f_swapc
_LOCAL["mulrow"] = _f_mulrow
_LOCAL["mulcol"] = _f_mulcol
_LOCAL["addrow"] = _f_addrow
_LOCAL["addcol"] = _f_addcol

# 顶层操作分类
_TRANSFORM_OPS = {"swap": 3, "swapc": 3, "mulrow": 3, "mulcol": 3,
                  "addrow": 4, "addcol": 4}
_JUDGE_OPS = {"invertible", "symmetric", "orthogonal", "posdef", "dependent"}
_JUDGE2_OPS = {"equivalent", "similar", "congruent"}
_JUDGE_LABELS = {
    "invertible": "可逆?",
    "symmetric": "对称?",
    "orthogonal": "正交?",
    "posdef": "正定?",
    "dependent": "相关?",
    "equivalent": "\\cong ?",
    "similar": "\\sim ?",
    "congruent": "\\simeq ?",
}
# 单矩阵操作(历史链用箭头 + 操作名标注, 而不是等号)
_OP_LABELS = {
    "det": "行列式", "transpose": "转置", "inverse": "求逆", "adjugate": "伴随",
    "rank": "秩", "trace": "迹", "diag": "对角化", "eigenval": "特征值",
    "eigenvect": "特征向量", "minor": "余子式", "cofactor": "代数余子式",
    "leading_minor": "顺序主子式", "echelon": "行阶梯", "rref": "行最简",
    "quadratic": "二次型", "standard": "标准形", "normal": "规范形",
}
_TOP_OP_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\s*\(", re.DOTALL)


# ---------------------------------------------------------------- 结果格式化

def _format_expr(expr) -> CalcResult:
    try:
        expr = simplify(expr)
    except Exception:
        pass
    if isinstance(expr, MatrixBase):
        mt = _matrix_to_text(expr)
        return CalcResult(text=mt, is_matrix=True, matrix_text=mt)
    if isinstance(expr, MatrixExpr):
        return CalcResult(text=str(expr))
    if isinstance(expr, _TextResult):
        return CalcResult(text=expr.text)
    if expr is None:
        raise CalcError("计算得到空结果")
    if expr.has(nan):
        raise CalcError("结果未定义 (NaN), 请检查分母或定义域")
    if expr.has(oo, -oo):
        return CalcResult(text=f"结果 = {expr} (发散, 结果为无穷大)")
    return CalcResult(text=f"结果 = {expr}")


def _exec_op(fn: str, body: str) -> CalcResult:
    """单矩阵操作(det/transpose/inverse/…): 结果带 kind=op 与操作名标签。"""
    args = _split_top(body)
    vals = [_eval_text(a) for a in args]
    func = _LOCAL[fn]
    try:
        expr = func(*vals)
    except CalcError:
        raise
    except Exception as exc:
        raise CalcError(f"{fn} 参数不正确: {exc}") from exc
    res = _format_expr(expr)
    res.kind = "op"
    res.label = _OP_LABELS[fn]
    return res


def _exec_top_op(fn: str, body: str) -> CalcResult:
    """处理顶层初等变换与判断类操作(带箭头标签)。"""
    args = _split_top(body)
    if fn in _TRANSFORM_OPS:
        need = _TRANSFORM_OPS[fn]
        if len(args) != need:
            raise CalcError(f"{fn} 需要 {need} 个参数: {fn}(矩阵, 下标…)")
        m = _eval_text(args[0])
        rest = [_eval_text(a) for a in args[1:]]
        func = _LOCAL[fn]
        out, label = func(m, *rest)
        mt = _matrix_to_text(out)
        return CalcResult(text=mt, kind="transform", label=label,
                          is_matrix=True, matrix_text=mt)
    need = 2 if fn in _JUDGE2_OPS else 1
    if len(args) != need:
        raise CalcError(f"{fn} 需要 {need} 个参数")
    vals = [_eval_text(a) for a in args]
    func = _LOCAL[fn]
    result = func(*vals)
    if isinstance(result, str):
        return CalcResult(text=result, kind="judge",
                          label=_JUDGE_LABELS[fn], judge_result=result)
    return _format_expr(result)


# ---------------------------------------------------------------- 对外接口

def compute(raw: str) -> CalcResult:
    """主入口:输入原始表达式文本,返回 CalcResult。

    格式错误抛 CalcError,无法求出抛 TooComplexError。
    """
    try:
        cleaned = _clean(raw)
        # 顶层单个操作调用(整个表达式就是一个 fn(...))?
        m = _TOP_OP_RE.match(cleaned)
        if m:
            fn_start = cleaned.index("(")
            end = _match_paren(cleaned, fn_start)
            if end == len(cleaned) - 1:
                name = cleaned[:fn_start].strip()
                # 初等变换/判断类: 特殊处理(带箭头标签, 变换会替换输入)
                if name in _TRANSFORM_OPS or name in _JUDGE_OPS or name in _JUDGE2_OPS:
                    return _exec_top_op(name, cleaned[fn_start + 1:end])
                # 单矩阵操作(det/转置/…): 历史链用箭头+操作名
                if name in _OP_LABELS:
                    return _exec_op(name, cleaned[fn_start + 1:end])
        expr = _eval_text(cleaned)
        return _format_expr(expr)
    except CalcError:
        raise
    except TooComplexError:
        raise
    except Exception as exc:
        raise TooComplexError() from exc


def extract_matrix_placeholder_positions(raw: str) -> list[tuple[int, int, str]]:
    """供 UI 使用:返回原始文本中矩阵字面量 [[...]] 的位置。"""
    return [(m.start(), m.end(), m.group(0)) for m in _MATRIX_LIT_RE.finditer(raw)]
