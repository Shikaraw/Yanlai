"""微分方程求解引擎:表达式清洗、微分方程识别与求解、求解条件、普通表达式计算。

求解算法按大学《高等数学》(同济版) 常微分方程章节编写:
- 一阶:可分离变量、齐次方程(含 u=y/x 代换)、可化为齐次的方程、一阶线性(积分因子法)、
  伯努利方程(令 z=y^(1-n))、以及 y'=f(ax+by) 代换型
- 高阶可降阶:y^(n)=f(x) 逐次积分、y''=f(x,y') 缺因变量型、y''=f(y,y') 缺自变量型
- 高阶线性:解的结构(齐次通解+非齐次特解)、常数变易法
- 常系数齐次线性:特征根法(按根的重数与复根分情况)
- 常系数非齐次线性:待定系数法(f=e^(λx)Pm(x) 与 f=e^(λx)[Pl cos(wx)+Qn sin(wx)] 两类)
- 欧拉方程:x^n y^(n)+p1 x^(n-1) y^(n-1)+...+pn y=f(x),令 x=e^t 化为常系数
- 其它基础类型:直接积分、SymPy dsolve 兜底

输入语法:
- 方程形式:y'=...、y''+3*y'+2*y=0、dy/dx=...、x^2*y''-2*x*y'+2*y=x^2 等
- 导数记号:y'、y''、y'''... (变量后几个撇号即几阶导);也支持 y^(n)、y^((n))
- 求解条件:y'|x=0=1、y|x=1=2、y''|x=0=0 (或 y'(0)=1),可添加多个
"""

from __future__ import annotations

import re

from sympy import (
    Add, Derivative, E, Eq, Function, I, Integral, Matrix, N, Piecewise, Poly,
    S, Symbol, conjugate, cos, diff, expand, exp, fraction, im, integrate, log,
    nan, oo, powdenest, re as sympy_re, roots, simplify, sin, solve, sympify,
)
from sympy.parsing.sympy_parser import (
    implicit_multiplication_application, parse_expr, standard_transformations,
)

try:
    from sympy.polys.polytools import NotPolynomialError
except ImportError:  # pragma: no cover
    NotPolynomialError = Exception

# 变量符号(强制为自由符号,避免与 sympy 内置函数/常量冲突)
_VARIABLES = {
    "x": Symbol("x"), "y": Symbol("y"), "z": Symbol("z"),
    "r": Symbol("r"), "t": Symbol("t"),
    "theta": Symbol("theta"), "phi": Symbol("phi"), "Phi": Symbol("Phi"),
    "alpha": Symbol("alpha"), "beta": Symbol("beta"),
}
_LOCAL_DICT = dict(_VARIABLES)
_LOCAL_DICT["e"] = E
_LOCAL_DICT["Derivative"] = Derivative

_TRANSFORMATIONS = standard_transformations + (implicit_multiplication_application,)


class CalcError(Exception):
    """格式错误:返回"表达式格式不正确: ..."消息。"""


class TooComplexError(Exception):
    """表达式无法求出:返回"表达式过于复杂, 无法求出!"消息。"""


# ---------------------------------------------------------------- 输入清洗

def _convert_derivative_marks(s: str) -> tuple[str, str | None]:
    """把导数记号(dy/dx、y'、y''、y^(n)、y^((n)))转成 Derivative(...) 文本。

    返回 (转换后的文本, 因变量名 或 None)。None 表示没有导数记号(普通表达式)。
    """
    s = re.sub(r"d\s*\(\s*y\s*\)\s*/\s*d\s*x", "y'", s)
    s = re.sub(r"d\s*y\s*/\s*d\s*x", "y'", s)
    m1 = re.findall(r"([A-Za-z])('+)", s)
    m2 = re.findall(r"([A-Za-z])\^\(\((\d+)\)\)", s)
    m3 = re.findall(r"([A-Za-z])\^\((\d+)\)", s)
    letters = {x[0] for x in m1} | {x[0] for x in m2} | {x[0] for x in m3}
    if not letters:
        return s, None
    if len(letters) > 1:
        raise CalcError("方程中只能有一个因变量(如 y), 请检查导数记号")
    dep = letters.pop()
    s = re.sub(rf"{dep}('+)",
               lambda mm: f"Derivative({dep}, x, {len(mm.group(1))})", s)
    s = re.sub(rf"{dep}\^\(\((\d+)\)\)",
               lambda mm: f"Derivative({dep}, x, {mm.group(1)})", s)
    s = re.sub(rf"{dep}\^\((\d+)\)",
               lambda mm: f"Derivative({dep}, x, {mm.group(1)})", s)
    return s, dep


def _clean(raw: str) -> tuple[str, str | None]:
    """把用户友好的数学书写转换成 sympy 可解析的文本。

    返回 (cleaned, 因变量名或 None)。
    """
    s = raw.strip().replace("\n", "").replace("\r", "")
    if not s:
        raise CalcError("表达式为空")
    s, dep = _convert_derivative_marks(s)
    # 占位符(〔〕)残留提前拦截,给出准确的"缺少…"提示
    if "〔" in s or "〕" in s:
        _check_placeholders(s)
    # 括号统一:中括号/大括号一律按普通括号处理(最内层优先级最高)
    s = s.replace("[", "(").replace("]", ")").replace("{", "(").replace("}", ")")
    s = s.replace("（", "(").replace("）", ")")
    s = s.replace("［", "(").replace("］", ")").replace("｛", "(").replace("｝", ")")
    # 运算符别名
    s = s.replace("×", "*").replace("·", "*").replace("÷", "/")
    s = s.replace("^", "**")
    # 希腊字母 -> 符号名
    s = s.replace("π", "pi").replace("θ", "theta").replace("φ", "phi")
    s = s.replace("Φ", "Phi").replace("α", "alpha").replace("β", "beta")
    # 函数名后紧跟字母/数字(无括号)时自动补括号,按数学习惯:
    #   sinx -> sin(x)、tanz -> tan(z)、lnx -> ln(x)、lgx -> lg(x)、sin2 -> sin(2)
    s = re.sub(
        r"(?<![A-Za-z_])(sinh|cosh|tanh|asin|acos|atan|csc|sec|cot|"
        r"sin|cos|tan|ln|lg|exp|sqrt|abs|log)\s*"
        r"([A-Za-z][A-Za-z0-9]*|[0-9]+)",
        r"\1(\2)", s)
    # 平方/立方上标
    s = s.replace("²", "**2").replace("³", "**3")
    # 根号:√(...) -> sqrt(...); √x -> sqrt(x); √2 -> sqrt(2)
    s = re.sub(r"√\s*\(([^()]*)\)", r"sqrt(\1)", s)
    s = re.sub(r"√\s*([A-Za-z][A-Za-z0-9_]*|[0-9]+)", r"sqrt(\1)", s)
    s = s.replace("√", "sqrt")  # 兜底
    # 对数:ln -> log(自然); lg -> log10(底数10)
    s = s.replace("ln", "log")
    s = s.replace("lg", "log10mark")
    s = re.sub(r"log10mark\s*\(([^()]*)\)", r"log(\1, 10)", s)
    # 绝对值 |...| -> Abs(...)  (循环处理嵌套)
    for _ in range(8):
        new = re.sub(r"\|([^|]+)\|", r"Abs(\1)", s)
        if new == s:
            break
        s = new
    if "|" in s:
        raise CalcError("绝对值符号 | 不配对")
    # 百分号: % -> /100
    s = s.replace("%", "/100")
    # 数字/字母/右括号 后紧跟 ∫ 时补乘号(如 2∫(...));不破坏 ∫∫/∫∫∫
    s = re.sub(r"(?<=[0-9A-Za-z\)!θφΦαβ])∫", r"*∫", s)
    # 字符白名单:parse_expr 底层是 eval,必须拦截一切非数学字符
    if not _ALLOWED_RE.match(s):
        bad = sorted({c for c in s if not _ALLOWED_RE.match(c)})
        raise CalcError("表达式包含不支持的字符: " + " ".join(repr(c) for c in bad[:5]))
    return s, dep


def _check_brackets(s: str) -> None:
    """检查圆括号配平(清洗后只剩圆括号)。"""
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


# ------------------------------------------------------------ 模板结构解析

_ALLOWED_RE = re.compile(r"^[0-9A-Za-z\s+\-*/^%!(),.'=|\[\]{}∫]+$")


_PLACEHOLDER_RE = re.compile(r"〔[^〕]*〕")


def find_placeholders(text: str) -> list[tuple[int, int, str]]:
    """返回所有占位符(〔内容〕)的位置 [(起始, 结束, 内容), ...],供 UI 点击定位。"""
    return [(m.start(), m.end(), m.group(0)) for m in _PLACEHOLDER_RE.finditer(text)]


def _check_placeholders(s: str) -> None:
    if "〔" in s or "〕" in s:
        missing = [m.group(0).strip("〔〕") for m in _PLACEHOLDER_RE.finditer(s)]
        if missing:
            raise CalcError("缺少" + "、".join(missing[:3]) + ("" if len(missing) <= 3 else " 等"))
        raise CalcError("输入含有未填写的占位符")


def _match_paren(s: str, start: int) -> int:
    """从 s[start]=='(' 开始,返回与之配对的 ')' 下标。"""
    depth = 0
    for i in range(start, len(s)):
        if s[i] == "(":
            depth += 1
        elif s[i] == ")":
            depth -= 1
            if depth == 0:
                return i
    raise CalcError("括号不全")


def _split_top(s: str) -> list[str]:
    """按最外层逗号拆分(不进入括号)。"""
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


# 操作模板:∫ 系列 与 d(...) 。记录 (kind, start, end, body),start/end 为在 cleaned 中的区间。
def _find_ops(cleaned: str) -> list[tuple[str, int, int, str]]:
    ops = []
    i = 0
    n = len(cleaned)
    while i < n:
        ch = cleaned[i]
        if ch == "∫":
            j = i
            while j < n and cleaned[j] == "∫":
                j += 1
            kind = "∫" * (j - i)
            k = j
            while k < n and cleaned[k] in " \t":
                k += 1
            if k >= n or cleaned[k] != "(":
                raise CalcError("积分符号后缺少括号, 正确格式如 ∫(函数, 变量, 下限, 上限)")
            end = _match_paren(cleaned, k)
            ops.append((kind, i, end + 1, cleaned[k + 1:end]))
            i = end + 1
        elif ch == "d" and (i == 0 or not (cleaned[i - 1].isalnum() or cleaned[i - 1] in "_θφΦαβ")):
            # 独立开头的 d(...) 才视为求导,避免误伤 sin/sqrt 等含 d 的单词
            j = i + 1
            while j < n and cleaned[j] in " \t":
                j += 1
            if j < n and cleaned[j] == "(":
                end = _match_paren(cleaned, j)
                ops.append(("d", i, end + 1, cleaned[j + 1:end]))
                i = end + 1
            else:
                i += 1
        else:
            i += 1
    return ops


# ---------------------------------------------------------------- 表达式解析

def _expr_of(s: str):
    """解析一段普通表达式文本为 sympy 表达式。"""
    try:
        return parse_expr(s, local_dict=_LOCAL_DICT, transformations=_TRANSFORMATIONS)
    except CalcError:
        raise
    except Exception as exc:
        raise CalcError(f"无法识别的表达式: {s!r} ({exc})") from exc


def _to_expr(s: str):
    """把一段文本转成表达式;空串/单空白返回 None。"""
    s = s.strip()
    if not s:
        return None
    return _expr_of(s)


class _Consts:
    """任意常数 C1、C2、C3... 的顺序生成器。"""

    def __init__(self):
        self.i = 0

    def next(self) -> Symbol:
        self.i += 1
        return Symbol(f"C{self.i}")


# ---------------------------------------------------------------- 普通表达式计算

_CN_NUM = {1: "定", 2: "二", 3: "三"}


def _build_integral(kind: str, body: str):
    """把 ∫/∫∫/∫∫∫ 的 body 转成 sympy 积分表达式。"""
    args = _split_top(body)
    count = len(kind)          # ∫ 的数量
    cn = _CN_NUM.get(count, str(count))
    if len(args) < 2:
        raise CalcError(f"{cn}积分缺少被积函数或积分变量")
    f_expr = _to_expr(args[0])
    if f_expr is None:
        raise CalcError("积分缺少被积函数")
    rest = args[1:]
    if count == 1:
        if len(rest) == 1:
            pairs = [(rest[0], None, None)]          # 不定积分
        elif len(rest) == 3:
            pairs = [tuple(rest)]                     # 定积分
        else:
            raise CalcError("定积分格式不正确, 应为 ∫(函数, 变量) 或 ∫(函数, 变量, 下限, 上限)")
    else:
        if len(rest) != count * 3:
            raise CalcError(f"{cn}重积分需要 {count} 个(变量, 下限, 上限)三元组, 共 {count * 3} 个参数")
        pairs = [tuple(rest[i:i + 3]) for i in range(0, len(rest), 3)]

    limits = []
    for var_s, lo_s, hi_s in pairs:
        if not var_s:
            raise CalcError("积分缺少积分变量")
        var = _expr_of(var_s)
        if not var.is_Symbol:
            raise CalcError(f"积分变量应为单个符号, 而不是 {var_s!r}")
        if lo_s is None:
            limits.append((var,))                    # 不定积分
        else:
            if not lo_s or not hi_s:
                raise CalcError("积分缺少上下限")
            lo, hi = _to_expr(lo_s), _to_expr(hi_s)
            limits.append((var, lo, hi))
    try:
        return integrate(f_expr, *limits)
    except CalcError:
        raise
    except (NotImplementedError, TypeError, ValueError, RecursionError) as exc:
        raise TooComplexError() from exc


def _build_derivative(body: str):
    """把 d(...) 的 body 转成 sympy 求导表达式。"""
    args = _split_top(body)
    if len(args) < 2:
        raise CalcError("求导格式不正确, 应为 d(函数, 变量) 或 d(函数, 变量, 阶数)")
    f_expr = _to_expr(args[0])
    if f_expr is None:
        raise CalcError("求导缺少函数表达式")
    var = _expr_of(args[1])
    if not var.is_Symbol:
        raise CalcError(f"求导变量应为单个符号, 而不是 {args[1]!r}")
    n = 1
    if len(args) >= 3:
        n_s = args[2].strip()
        try:
            n_expr = sympify(n_s, locals=_LOCAL_DICT)
            if n_expr is None or not n_expr.is_integer:
                raise CalcError(f"求导阶数应为整数, 而不是 {n_s!r}")
            n = int(n_expr)
        except CalcError:
            raise
        except Exception as exc:
            raise CalcError(f"求导阶数应为整数, 而不是 {n_s!r}") from exc
        if n <= 0:
            raise CalcError("求导阶数应为正整数")
    try:
        return diff(f_expr, var, n)
    except CalcError:
        raise
    except (NotImplementedError, TypeError, ValueError, RecursionError) as exc:
        raise TooComplexError() from exc


def _format_result(expr) -> str:
    """把结果整理成展示文本(符号形式 + 数值近似)。"""
    if expr is None:
        raise CalcError("计算得到空结果")
    if expr.has(nan):
        raise CalcError("结果未定义 (NaN), 请检查分母或定义域")
    if expr.has(oo, -oo):
        return f"结果 = {expr}  (发散, 结果为无穷大)"
    if expr.has(Integral):
        raise TooComplexError()
    if expr.has(Derivative):
        raise TooComplexError()
    symbolic = str(expr)
    numeric = None
    try:
        val = N(expr, 12)
        if val.is_number and not val.has(oo, nan):
            numeric = str(val)
    except Exception:
        numeric = None
    if numeric is not None and numeric != symbolic:
        return f"结果 = {symbolic}\n数值 ≈ {numeric}"
    return f"结果 = {symbolic}"


def compute_general(cleaned: str) -> str:
    """普通表达式计算(非微分方程):化简 / 积分 / 求导。"""
    _check_brackets(cleaned)
    ops = _find_ops(cleaned)
    if not ops:
        expr = simplify(_expr_of(cleaned))
        return _format_result(expr)
    if len(ops) > 1:
        raise CalcError("一次只能计算一个积分或求导, 请分开输入")
    kind, start, end, body = ops[0]
    if kind.startswith("∫"):
        op_expr = _build_integral(kind, body)
    else:
        op_expr = _build_derivative(body)
    token = "__calctoken"
    text = cleaned[:start] + token + cleaned[end:]
    if text.strip() == token:
        expr = op_expr
    else:
        local = dict(_LOCAL_DICT)
        local[token] = op_expr
        expr = parse_expr(text, local_dict=local, transformations=_TRANSFORMATIONS)
    expr = simplify(expr)
    return _format_result(expr)


# ================================================================ ODE 求解

def _order(d: Derivative) -> int:
    """Derivative 的阶数:args 结构为 (函数, (变量, 阶数), ...)。"""
    o = 0
    for item in d.args[1:]:
        if len(item) == 2:
            o += int(item[1])
    return o


def _deriv_vars(d: Derivative) -> list[Symbol]:
    """Derivative 的导数变量符号列表。"""
    out = []
    for item in d.args[1:]:
        if len(item) == 2 and isinstance(item[0], Symbol):
            out.append(item[0])
    return out


def _safe_solve(*args, **kwargs):
    """solve 的安全包装:求解失败(如超越方程无算法)时返回 []。"""
    try:
        return solve(*args, **kwargs)
    except Exception:
        return []


def _determine_indep(eq, y: Symbol) -> Symbol:
    """确定自变量:方程中除因变量 y 之外的唯一自由符号(u 保留给 y/x 代换)。

    sympy 的 Derivative 自由符号不包含导数变量,需手动收集;
    仅出现在导数记号位置的 x(如 z'=2*t*z 中的 x)不参与自变量判定。
    """
    free = {s for s in eq.free_symbols if isinstance(s, Symbol)}
    dvars = set()
    for d in eq.atoms(Derivative):
        for v in _deriv_vars(d):
            dvars.add(v)
    others = {s for s in free if s != y and s.name != "u"}
    if len(others) > 1:
        raise CalcError(
            "方程包含多个变量 " + "、".join(sorted(s.name for s in others))
            + ", 无法确定自变量")
    if others:
        return others.pop()
    deriv_only = {s for s in dvars if s != y and s.name != "u"}
    if len(deriv_only) != 1:
        raise CalcError("无法确定自变量(方程除因变量外没有其它变量)")
    return deriv_only.pop()


def _highest_order(eq, y: Symbol) -> int:
    ds = [d for d in eq.atoms(Derivative) if d.args[0] == y]
    if not ds:
        return 0
    return max(_order(d) for d in ds)


def _eq_has_bare_y(eq, y: Symbol, n: int) -> bool:
    """方程中 y 是否以"非导数"形式出现(如 y、y**2)。"""
    sub = {d: S(0) for d in eq.atoms(Derivative) if d.args[0] == y}
    rest = eq.subs(sub)
    return y in rest.free_symbols


def _eq_has_x_outside(eq, y: Symbol, x: Symbol, n: int) -> bool:
    """方程中自变量 x 是否出现在非导数变量位置。"""
    sub = {d: S(0) for d in eq.atoms(Derivative) if d.args[0] == y}
    rest = eq.subs(sub)
    return x in rest.free_symbols


def _ensure_integrated(expr) -> None:
    """显式解中残留未求值积分 → 视为无法求出。"""
    if expr.has(Integral):
        raise TooComplexError("积分无法求出")


def _extract_R(eq, y: Symbol, x: Symbol):
    """从一阶方程解出 y' = R(x, y)。"""
    d1 = Derivative(y, x)
    s = Symbol("__dy1")
    eq2 = eq.subs({d1: s})
    try:
        p = Poly(eq2, s)
    except Exception:
        raise CalcError("方程无法表示为 y' 的多项式, 暂不支持")
    if p.degree() > 1:
        raise CalcError("方程关于 y' 是非线性的, 暂不支持")
    sols = solve(eq2, s)
    if not sols:
        raise CalcError("无法从方程中解出 y'")
    if len(sols) > 1:
        raise CalcError("方程关于 y' 有多解, 暂不支持")
    return sols[0]


def _extract_y_parts(R, y: Symbol):
    """把 R 拆成 [(y 的幂次, 系数), ...];无法表示为 c(x)*y^k 单项和时返回 None。"""
    out = []
    for t in Add.make_args(R):
        try:
            c, yp = t.as_independent(y, as_Add=False)
        except Exception:
            return None
        if c.has(y):
            return None
        if yp == 1:
            k = S(0)
        else:
            b, e = yp.as_base_exp()
            if b != y:
                return None
            k = e
        out.append((k, c))
    return out


# ------------------------------------------------------------ 一阶微分方程

def _solve_homogeneous(y, x, R, consts, force=False):
    """齐次方程 dy/dx = f(y/x):令 u=y/x,y=ux,得 du/(f(u)-u)=dx/x。

    force=True 表示用户显式用了 u=y/x 记号(预设),不再检查齐次性。
    """
    u = Symbol("u")
    fu = simplify(R.subs({x: S(1), y: u}))          # f(1, u)
    g = simplify(fu - u)
    if g == 0:
        return ("explicit", _next_const(consts) * x, None,
                "齐次方程(特殊情形 f(u)=u, 通解 y=Cx)")
    if force or simplify(R.subs({x: Symbol("t") * x, y: Symbol("t") * y}) - R) == 0:
        C = _next_const(consts)
        intg = integrate(1 / g, u)
        rhs = log(x) + C
        if intg.has(Integral):
            return ("implicit", intg, rhs, "齐次方程(变量代换 u=y/x, 隐式解)")
        sols = _safe_solve(Eq(intg, rhs), u)
        if sols:
            return ("explicit", simplify(sols[0] * x), None,
                    "齐次方程(变量代换 u=y/x)")
        return ("implicit", intg, rhs, "齐次方程(变量代换 u=y/x, 隐式解)")
    raise CalcError("内部错误: 齐次检测失败")


def _solve_reducible_homogeneous(y, x, num, den, consts):
    """可化为齐次的方程 dy/dx=(ax+by+c)/(a1x+b1y+c1)。

    同济教材:行列式非零时平移 x=X+h,y=Y+k 化为齐次;
    行列式为零时令 u=ax+by 化为可分离变量。
    """
    try:
        pn = Poly(num, x, y)
        pd = Poly(den, x, y)
    except Exception:
        return None
    if pn.total_degree() > 1 or pd.total_degree() > 1:
        return None
    a = pn.coeff_monomial(x)
    b = pn.coeff_monomial(y)
    c = pn.coeff_monomial(S(1))
    a1 = pd.coeff_monomial(x)
    b1 = pd.coeff_monomial(y)
    c1 = pd.coeff_monomial(S(1))
    if (a == 0 and b == 0) or (a1 == 0 and b1 == 0):
        return None                       # 退化为已处理类型
    det = simplify(a * b1 - b * a1)
    if det != 0:
        h, k = Symbol("h"), Symbol("k")
        sols = _safe_solve([Eq(a * h + b * k + c, 0), Eq(a1 * h + b1 * k + c1, 0)],
                           [h, k], dict=True)
        if not sols:
            return None
        h0, k0 = sols[0][h], sols[0][k]
        X, Y = Symbol("X"), Symbol("Y")
        R2 = (a * X + b * Y) / (a1 * X + b1 * Y)
        kind, a, b, method = _solve_homogeneous(Y, X, R2, consts)
        if kind == "explicit":
            expr = a.subs(X, x - h0) + k0
            return ("explicit", simplify(expr), None,
                    "可化为齐次的方程(平移变换 x=X+h, y=Y+k)")
        lhs, rhs = a, b
        lhs = lhs.subs(Symbol("u"), (y - k0) / (x - h0))
        rhs = rhs.subs(X, x - h0)
        return ("implicit", lhs, rhs,
                "可化为齐次的方程(平移变换 x=X+h, y=Y+k)")
    # det == 0: a1/a = b1/b = m, 令 u = a x + b y
    if a != 0:
        m = simplify(a1 / a)
    else:
        m = simplify(b1 / b)
    u = Symbol("u")
    du = simplify(a + b * (u + c) / (m * u + c1))
    C = _next_const(consts)
    intg = integrate(1 / du, u)
    rhs = x + C
    if intg.has(Integral):
        lhs = intg.subs(u, a * x + b * y)
        return ("implicit", lhs, rhs,
                "可化为齐次的方程(行列式为零, 令 u=ax+by)")
    sols = _safe_solve(Eq(intg, rhs), u)
    if sols:
        usol = sols[0]
        return ("explicit", simplify((usol - a * x) / b), None,
                "可化为齐次的方程(行列式为零, 令 u=ax+by)")
    lhs = intg.subs(u, a * x + b * y)
    return ("implicit", lhs, rhs,
            "可化为齐次的方程(行列式为零, 令 u=ax+by, 隐式解)")


def _solve_linear_first(y, x, R, consts):
    """一阶线性 y'+P(x)y=Q(x):积分因子 e^∫P dx。"""
    A = simplify(diff(R, y))
    B = simplify(R - A * y)
    p_int = integrate(-A, x)
    C = _next_const(consts)
    sol = simplify(exp(-p_int) * (integrate(B * exp(p_int), x) + C))
    _ensure_integrated(sol)
    return ("explicit", sol, None, "一阶线性微分方程(积分因子法)")


def _solve_bernoulli(y, x, R, consts):
    """伯努利方程 y'+P(x)y=Q(x)y^n:令 z=y^(1-n) 化为线性。"""
    parts = _extract_y_parts(R, y)
    if parts is None:
        return None
    pows = {k for k, _ in parts}
    if 1 not in pows or len(pows) > 2:
        return None
    A = simplify(sum(c for k, c in parts if k == 1))
    others = [(k, c) for k, c in parts if k != 1]
    if len(others) != 1:
        return None
    k, B = others[0]
    if k == 0 or k == 1:
        return None
    n = k
    P = -A                                  # y' - A y = B y^n → P = -A
    Q = B
    m1 = 1 - n                              # z = y^{m1}
    p_int = integrate(m1 * P, x)
    C = _next_const(consts)
    z = simplify(exp(-p_int) * (integrate(m1 * Q * exp(p_int), x) + C))
    sol = simplify(z ** (1 / m1))
    _ensure_integrated(sol)
    return ("explicit", sol, None, f"伯努利方程(令 z=y^{{{1 - n}}}, 化为线性)")


def _solve_separable(y, x, R, consts):
    """可分离变量 dy/dx = g(x)h(y)。"""
    try:
        mixed = simplify(diff(log(R), x, y))
    except Exception:
        return None
    if mixed != 0:
        return None
    g = None
    for y0 in (S(0), S(1), -S(1), S(2), S(1) / 2):
        try:
            g0 = R.subs(y, y0)
            if g0 == 0 or g0.has(S.ComplexInfinity, oo, -oo, nan):
                continue
            g = simplify(g0)
            break
        except Exception:
            continue
    if g is None:
        return None
    h = simplify(R / g)
    if h.has(x):
        return None
    intg_h = integrate(1 / h, y)
    intg_g = integrate(g, x)
    C = _next_const(consts)
    rhs = intg_g + C
    if intg_h.has(Integral) or intg_g.has(Integral):
        return ("implicit", intg_h, rhs, "可分离变量(隐式解)")
    sols = _safe_solve(Eq(intg_h, rhs), y)
    if len(sols) == 1:
        return ("explicit", simplify(sols[0]), None, "可分离变量")
    return ("implicit", intg_h, rhs, "可分离变量(隐式解)")


def _solve_linear_combo(y, x, R, consts):
    """y'=f(ax+by+c) 型:令 u=ax+by 化为可分离变量(同济教材之外的补充类型)。"""
    try:
        dx = diff(R, x)
        dy = diff(R, y)
    except Exception:
        return None
    if dx == 0 or dy == 0:
        return None
    k = simplify(dy / dx)
    if k.free_symbols != set() or k == 0:
        return None
    u = Symbol("u")
    F = simplify(R.subs(y, (u - x) / k))
    if x in F.free_symbols:
        return None
    denom = simplify(1 + k * F)
    C = _next_const(consts)
    intg = integrate(1 / denom, u)
    if intg.has(Integral):
        return None
    lhs = intg.subs(u, x + k * y)
    sols = _safe_solve(Eq(intg, x + C), u)
    if sols:
        usol = sols[0]
        return ("explicit", simplify((usol - x) / k), None,
                "y'=f(ax+by) 型(令 u=ax+by)")
    return ("implicit", lhs, x + C, "y'=f(ax+by) 型(令 u=ax+by, 隐式解)")


def _sub_u_back(result, y, x):
    """把齐次解中的中间变量 u 代回 u=y/x(隐式解时)。"""
    if result[0] == "implicit":
        lhs, rhs = result[1], result[2]
        return ("implicit", lhs.subs(Symbol("u"), y / x), rhs, result[3])
    return result


def _solve_first_order(y, x, R, consts):
    """解一阶微分方程 y' = R(x, y),按同济教材顺序自动分类。"""
    u = Symbol("u")
    # 0) 显式 u=y/x 记号(齐次预设)
    if u in R.free_symbols:
        R = R.subs(u, y / x)
        r = _solve_homogeneous(y, x, R, consts, force=True)
        return _sub_u_back(r, y, x)
    # 1) R 不含 y → 直接积分
    if y not in R.free_symbols:
        C = _next_const(consts)
        sol = simplify(integrate(R, x) + C)
        _ensure_integrated(sol)
        return ("explicit", sol, None, "直接积分")
    # 2) R 不含 x → 分离变量
    if x not in R.free_symbols:
        intg = integrate(1 / R, y)
        C = _next_const(consts)
        rhs = x + C
        if intg.has(Integral):
            return ("implicit", intg, rhs, "可分离变量(隐式解)")
        sols = _safe_solve(Eq(intg, rhs), y)
        if len(sols) == 1:
            return ("explicit", simplify(sols[0]), None, "可分离变量")
        # 多个反函数分支(例如 y'=1/y 的 ±sqrt)不能安全地挑选一个；
        # 保留隐式通解，避免初值条件被错误地套到另一分支。
        return ("implicit", intg, rhs, "可分离变量(隐式解)")
    # 3) 可分离变量(通用检测)
    r = _solve_separable(y, x, R, consts)
    if r is not None:
        return r
    # 4) 齐次方程
    t = Symbol("t")
    if simplify(R.subs({x: t * x, y: t * y}) - R) == 0:
        return _sub_u_back(_solve_homogeneous(y, x, R, consts), y, x)
    # 5) 可化为齐次的方程
    num, den = fraction(simplify(R))
    if den != 0:
        r = _solve_reducible_homogeneous(y, x, num, den, consts)
        if r is not None:
            return r
    # 6) 一阶线性
    try:
        if Poly(R, y).degree() <= 1:
            return _solve_linear_first(y, x, R, consts)
    except Exception:
        pass
    # 7) 伯努利方程
    r = _solve_bernoulli(y, x, R, consts)
    if r is not None:
        return r
    # 8) y'=f(ax+by) 代换型
    r = _solve_linear_combo(y, x, R, consts)
    if r is not None:
        return r
    # 9) 兜底
    return _dsolve_fallback(y, x, R - Derivative(y, x), consts)


# ------------------------------------------------------------ 高阶微分方程

def _reduce_no_y(y, x, eq, n, consts):
    """可降阶(缺因变量型):令 p=y',方程不含 y。"""
    p = Symbol("p")
    sub = {}
    for k in range(1, n + 1):
        dk = Derivative(y, x, k)
        if dk in eq.atoms(Derivative):
            sub[dk] = p if k == 1 else Derivative(p, x, k - 1)
    eq_p = eq.subs(sub)
    kind, a, b, method = _solve_ode(p, x, eq_p, consts)
    payload = a
    if kind != "explicit":
        raise TooComplexError("缺因变量型降阶得到隐式解, 无法继续积分")
    _ensure_integrated(payload)
    y_expr = simplify(integrate(payload, x) + _next_const(consts))
    _ensure_integrated(y_expr)
    return ("explicit", y_expr, None, "可降阶(缺因变量型, 令 p=y')")


def _reduce_no_x(y, x, eq, consts):
    """可降阶(缺自变量型) y''=f(y,y'):令 p=y',y''=p dp/dy。"""
    p = Symbol("p")
    sub = {
        Derivative(y, x, 2): p * diff(p, y),
        Derivative(y, x, 1): p,
    }
    eq_p = eq.subs(sub)
    dpy = Derivative(p, y)
    sols = _safe_solve(eq_p, dpy)
    if len(sols) != 1:
        raise TooComplexError("缺自变量型方程无法降阶")
    R = sols[0]
    kind, a, b, method = _solve_first_order(p, y, R, consts)
    payload = a
    if kind != "explicit":
        raise TooComplexError("缺自变量型降阶得到隐式解, 无法继续积分")
    _ensure_integrated(payload)
    intg = integrate(1 / payload, y)
    if intg.has(Integral):
        raise TooComplexError("缺自变量型方程积分失败")
    return ("implicit", intg, x + _next_const(consts),
            "可降阶(缺自变量型, 令 p=y')")


def _is_euler_eq(eq, y, x, n):
    """欧拉方程识别:x^k y^(k) 各项系数为常数。

    返回 ([a_n, ..., a_0], f(x)) 或 None。a_k 是 x^k y^(k) 的系数。
    """
    coeffs = [S(0)] * (n + 1)
    for d in eq.atoms(Derivative):
        if d.args[0] != y:
            continue
        k = _order(d)
        c = eq.coeff(d)
        c = simplify(c / x**k)
        if c.free_symbols:
            return None
        coeffs[k] = c
    c0 = eq.coeff(y)
    if c0.free_symbols:
        return None
    coeffs[0] = c0
    rest = eq
    for k in range(1, n + 1):
        rest = simplify(rest - coeffs[k] * x**k * Derivative(y, x, k))
    rest = simplify(rest - coeffs[0] * y)
    if y in rest.free_symbols:
        return None
    f = simplify(-rest)
    return coeffs, f


def _roots_with_mult(poly, r):
    """求特征多项式 poly(r)=0 的根列表 [(根, 重数), ...]。符号优先, 失败用数值。"""
    try:
        rd = roots(poly, r)
    except Exception:
        rd = {}
    if rd:
        items = []
        for rr, mm in rd.items():
            if isinstance(mm, int) or (hasattr(mm, "is_integer") and mm.is_integer):
                items.append((rr, int(mm)))
            else:
                items.append((rr, 1))
        return items
    # 数值根(nroots 重根重复出现)
    try:
        nrs = poly.nroots()
    except Exception:
        raise TooComplexError("特征方程求根失败")
    return [(nr, 1) for nr in nrs]


def _is_real_root(r) -> bool:
    if r.is_real is True:
        return True
    try:
        v = complex(r.evalf())
        return abs(v.imag) < 1e-9
    except Exception:
        return False


def _same_root(a, b) -> bool:
    try:
        if simplify(a - b) == 0:
            return True
    except Exception:
        pass
    try:
        return abs(complex(a.evalf()) - complex(b.evalf())) < 1e-6
    except Exception:
        return False


def _group_roots(root_list):
    """把特征根分组:实根(合并重数)与共轭复根对。root_list 为 [(根, 重数), ...]。"""
    remain = []
    for r, m in root_list:
        remain += [r] * int(m)
    groups = []
    while remain:
        r = remain[0]
        if _is_real_root(r):
            same = [s for s in remain if _same_root(s, r)]
            groups.append(("real", r, len(same)))
            remain = [s for s in remain if not _same_root(s, r)]
        else:
            conj = conjugate(r)
            m_r = len([s for s in remain if _same_root(s, r)])
            a = sympy_re(r)
            b = im(r)
            groups.append(("complex", a, b, m_r))
            remain = [s for s in remain
                      if not (_same_root(s, r) or _same_root(s, conj))]
    return groups


def _homogeneous_basis(y, x, root_list):
    """由特征根生成线性无关齐次解基 [y1, ..., yn](同济特征根法)。"""
    basis = []
    for group in _group_roots(root_list):
        if group[0] == "real":
            _, rr, mult = group
            for j in range(mult):
                basis.append(x**j * exp(rr * x))
        else:
            _, a, b, mult = group
            for j in range(mult):
                basis.append(x**j * exp(a * x) * cos(b * x))
                basis.append(x**j * exp(a * x) * sin(b * x))
    return basis


def _next_const(consts: _Consts) -> Symbol:
    return consts.next()


def _general_solution(y, x, basis, consts):
    return Add(*[_next_const(consts) * yj for yj in basis])


def _mult_of_root(root_list, val) -> int:
    """val 作为特征根的重数(非根则为 0)。"""
    m = 0
    for r, mm in root_list:
        if _same_root(r, val):
            m += mm
    return m


def _L_op(y, x, n, pcoeff, ystar):
    """线性算符 L[y*] = Σ pcoeff[k] * y*^(n-k)。"""
    out = S(0)
    for k in range(n + 1):
        out += pcoeff[k] * diff(ystar, x, n - k)
    return out


def _sub_free(ystar, sol, unknowns):
    """代入解;未确定的自由参数(欠定)赋 0。"""
    e = ystar
    used = set()
    for d in sol:
        for k, v in d.items():
            e = e.subs(k, v)
            used.add(k)
    for k in unknowns:
        if k not in used:
            e = e.subs(k, S(0))
    return simplify(e)


def _classify_term(t, x):
    """把非齐次项分类为 ('exp', λ, 多项式次数) 或 ('trig', λ, w, 次数)。

    f = e^(λx) Pm(x) 或 f = e^(λx)[Pl cos(wx) + Qn sin(wx)];失败返回 None。
    """
    t = simplify(t)
    exps = [a for a in t.atoms(exp) if a.free_symbols]
    lam = S(0)
    rest = t
    for e in exps:
        arg = e.args[0]
        a = simplify(arg.diff(x))
        if a.free_symbols:
            return None
        lam += a
        rest = simplify(rest / e)
    trig = (rest.atoms(cos) | rest.atoms(sin))
    if trig:
        ws = set()
        for fn in trig:
            wc = simplify(fn.args[0] / x)
            if wc.free_symbols:
                return None
            ws.add(simplify(wc))
        if len(ws) > 2:
            return None
        wlist = list(ws)
        if len(wlist) == 2 and simplify(wlist[0] + wlist[1]) != 0:
            return None
        w = simplify(abs(wlist[0])) if wlist else S(0)
        A = simplify(rest.coeff(cos(w * x)))
        B = simplify(rest.coeff(sin(w * x)))
        if simplify(rest - (A * cos(w * x) + B * sin(w * x))) != 0:
            return None
        try:
            da = Poly(A, x).degree()
            db = Poly(B, x).degree()
        except Exception:
            return None
        return ("trig", lam, w, max(da, db))
    try:
        P = Poly(rest, x)
    except Exception:
        return None
    return ("exp", lam, P.degree())


def _particular_term(y, x, n, pcoeff, t, root_list):
    """对单个标准非齐次项求特解(待定系数法, 教材两类 f(x))。"""
    cls = _classify_term(t, x)
    if cls is None:
        raise TooComplexError("非齐次项形式暂不支持")
    if cls[0] == "exp":
        _, lam, deg0 = cls
        k = _mult_of_root(root_list, lam)
        for m in range(deg0, deg0 + 8):
            q = [Symbol(f"_a{i}") for i in range(m + 1)]
            Q = sum(q[i] * x**i for i in range(m + 1))
            ystar = x**k * exp(lam * x) * Q
            de = simplify(expand((_L_op(y, x, n, pcoeff, ystar) - t)
                                 / exp(lam * x)))
            if de.has(exp, cos, sin):
                continue
            try:
                eqs = Poly(de, x).all_coeffs()
            except Exception:
                break
            sol = solve(eqs, q, dict=True)
            if sol:
                return _sub_free(ystar, sol, q)
        raise TooComplexError("待定系数法无解")
    _, lam, w, deg0 = cls
    k = _mult_of_root(root_list, lam + I * w)
    for m in range(deg0, deg0 + 8):
        ra = [Symbol(f"_a{i}") for i in range(m + 1)]
        rb = [Symbol(f"_b{i}") for i in range(m + 1)]
        Rm = sum(ra[i] * x**i for i in range(m + 1))
        Sm = sum(rb[i] * x**i for i in range(m + 1))
        ystar = x**k * exp(lam * x) * (Rm * cos(w * x) + Sm * sin(w * x))
        de = simplify(expand((_L_op(y, x, n, pcoeff, ystar) - t)
                             / exp(lam * x)))
        c1 = de.coeff(cos(w * x))
        s1 = de.coeff(sin(w * x))
        rest = simplify(de - c1 * cos(w * x) - s1 * sin(w * x))
        if rest != 0:
            break
        try:
            eqs = Poly(c1, x).all_coeffs() + Poly(s1, x).all_coeffs()
        except Exception:
            break
        sol = solve(eqs, ra + rb, dict=True)
        if sol:
            return _sub_free(ystar, sol, ra + rb)
    raise TooComplexError("待定系数法无解")


def _variation(y, x, n, pcoeff, f, basis, consts):
    """常数变易法求非齐次特解(已知齐次解基 basis)。"""
    W = []
    for i in range(n):
        W.append([diff(yj, x, i) for yj in basis])
    M = Matrix(W)
    bvec = Matrix([S(0)] * (n - 1) + [simplify(f)])
    try:
        vp = M.LUsolve(bvec)
    except Exception:
        raise TooComplexError("常数变易法失败")
    v = []
    for i in range(n):
        vi = integrate(vp[i, 0], x)
        if vi.has(Integral):
            raise TooComplexError("常数变易法积分失败")
        v.append(vi)
    return simplify(Add(*[v[i] * basis[i] for i in range(n)]))


def _particular(y, x, n, pcoeff, f, root_list):
    """非齐次特解:标准项用待定系数法, 叠加原理;失败抛 TooComplexError。"""
    terms = Add.make_args(f)
    yp = S(0)
    for t in terms:
        yp += _particular_term(y, x, n, pcoeff, t, root_list)
    return simplify(yp)


def _solve_const_coeff(y, x, n, coeffs, f, consts):
    """常系数线性微分方程(特征根法 + 待定系数/常数变易)。"""
    an = coeffs[0]
    pcoeff = [simplify(c / an) for c in coeffs]     # pcoeff[0] = 1
    r = Symbol("r")
    poly = r**n + sum(pcoeff[k] * r**(n - k) for k in range(1, n + 1))
    root_list = _roots_with_mult(poly, r)
    basis = _homogeneous_basis(y, x, root_list)
    yh = _general_solution(y, x, basis, consts)
    if f == 0:
        return ("explicit", yh, None, f"{n}阶常系数齐次线性(特征根法)")
    try:
        yp = _particular(y, x, n, pcoeff, f, root_list)
    except TooComplexError:
        yp = _variation(y, x, n, pcoeff, f, basis, consts)
    return ("explicit", simplify(yh + yp), None,
            "常系数非齐次线性(特征根法+待定系数法)")


def _solve_euler(y, x, n, coeffs, f, consts):
    """欧拉方程 x^n y^(n)+...+pn y=f(x):令 x=e^t 化为常系数。"""
    t = Symbol("t")
    Dv = Symbol("Dv")
    poly = S(0)
    for k in range(n + 1):
        op = S(1)
        for i in range(k):
            op = expand(op * (Dv - i))
        poly += coeffs[k] * op
    an = poly.coeff(Dv, n)
    poly = expand(poly / an)
    pcoeff = [poly.coeff(Dv, k) for k in range(n, -1, -1)]  # [D^n, ..., D, 1]
    g = simplify(f.subs(x, exp(t)))
    r = Symbol("r")
    root_list = _roots_with_mult(poly.subs(Dv, r), r)
    basis = _homogeneous_basis(y, t, root_list)
    yh = _general_solution(y, t, basis, consts)
    if g != 0:
        try:
            yp = _particular(y, t, n, pcoeff, g, root_list)
        except TooComplexError:
            yp = _variation(y, t, n, pcoeff, g, basis, consts)
        sol_t = simplify(yh + yp)
    else:
        sol_t = yh
    sol = sol_t.subs(t, log(x))
    sol = powdenest(sol, force=True)
    return ("explicit", simplify(sol), None, "欧拉方程(令 x=e^t 化为常系数)")


def _dsolve_fallback(y, x, eq, consts):
    """SymPy dsolve 兜底(覆盖其它较基础类型)。"""
    from sympy.solvers.ode import dsolve
    f = Function("y")(x)
    sub = {y: f}
    for d in eq.atoms(Derivative):
        if d.args[0] == y:
            sub[d] = Derivative(f, x, _order(d))
    eqf = eq.subs(sub)
    try:
        sol = dsolve(Eq(eqf, 0), f)
    except Exception:
        raise TooComplexError()
    if isinstance(sol, list):
        sol = sol[0] if sol else None
    if sol is None:
        raise TooComplexError()
    lhs, rhs = sol.lhs, sol.rhs
    # 取 Piecewise 第一分支(避免分段条件显示)
    if rhs.has(Piecewise):
        rhs = rhs.args[0][0]
    if lhs.has(Piecewise):
        lhs = lhs.args[0][0]
    # 常数统一到 C1..Cn 系列
    syms = sorted(
        {s for s in (lhs.free_symbols | rhs.free_symbols)
         if isinstance(s, Symbol) and re.fullmatch(r"C\d+", s.name)},
        key=lambda s: int(s.name[1:]))
    mapping = {s: _next_const(consts) for s in syms}
    lhs = lhs.subs(mapping)
    rhs = rhs.subs(mapping)
    lhs = lhs.subs(f, y)
    rhs = rhs.subs(f, y)
    if lhs.has(Integral) or rhs.has(Integral):
        raise TooComplexError("无法求出初等解")
    if lhs == y:
        return ("explicit", simplify(rhs), None, "SymPy dsolve 求解")
    return ("implicit", simplify(lhs), simplify(rhs), "SymPy dsolve 求解(隐式解)")


def _check_linear(eq, y, x, n):
    """检测方程对 y, y', ..., y^(n) 是否线性;是则返回 ([a_n,...,a_0], f)。"""
    subs = {}
    gens = []
    for k in range(1, n + 1):
        d = Derivative(y, x, k)
        s = Symbol(f"__d{k}")
        subs[d] = s
        gens.append(s)
    eq2 = eq.subs(subs)
    try:
        poly = Poly(eq2, y, *gens)
    except Exception:
        return None
    if poly.total_degree() > 1:
        return None
    coeffs = []
    for k in range(n, 0, -1):
        coeffs.append(poly.coeff_monomial(Symbol(f"__d{k}")))
    coeffs.append(poly.coeff_monomial(y))
    f = -poly.coeff_monomial(S(1))
    return coeffs, f


def _solve_ode(y, x, eq, consts):
    """微分方程总入口:自动识别类型并求解。返回 (kind, payload, method)。"""
    n = _highest_order(eq, y)
    if n == 1:
        R = _extract_R(eq, y, x)
        return _solve_first_order(y, x, R, consts)

    dn = Derivative(y, x, n)
    bare_y = _eq_has_bare_y(eq, y, n)
    orders = {_order(d) for d in eq.atoms(Derivative) if d.args[0] == y}

    # 1) 欧拉方程
    eu = _is_euler_eq(eq, y, x, n)
    if eu is not None:
        return _solve_euler(y, x, n, eu[0], eu[1], consts)

    # 2) 常系数线性
    lin = _check_linear(eq, y, x, n)
    if lin is not None:
        coeffs, f = lin
        if all(c.free_symbols == set() for c in coeffs):
            try:
                return _solve_const_coeff(y, x, n, coeffs, f, consts)
            except TooComplexError:
                pass                      # 继续尝试可降阶

    # 3) 可降阶 a: y^(n) = f(x)(无 y、无低阶导数)
    if not bare_y and orders == {n}:
        an = eq.coeff(dn)
        f = -simplify(eq - an * dn)
        g = simplify(f / an)
        sol = g
        for _ in range(n):
            sol = integrate(sol, x) + _next_const(consts)
        _ensure_integrated(sol)
        return ("explicit", simplify(sol), None,
                f"可降阶高阶微分方程(逐次积分, y^({n})=f(x))")

    # 4) 可降阶 b: 缺因变量(令 p=y')
    if not bare_y:
        try:
            return _reduce_no_y(y, x, eq, n, consts)
        except TooComplexError:
            pass

    # 5) 可降阶 c: 缺自变量 y''=f(y,y')(令 p=y', y''=p dp/dy)
    if n == 2 and not _eq_has_x_outside(eq, y, x, n):
        try:
            return _reduce_no_x(y, x, eq, consts)
        except TooComplexError:
            pass

    # 6) 变系数线性 → dsolve 兜底
    if lin is not None:
        try:
            return _dsolve_fallback(y, x, eq, consts)
        except TooComplexError:
            pass

    # 7) 兜底
    return _dsolve_fallback(y, x, eq, consts)


# ---------------------------------------------------------------- 求解条件

_COND_RE = re.compile(r"^\s*([A-Za-z]'*)\s*\|\s*([A-Za-z]\w*)\s*=\s*(.+?)\s*=\s*(.+?)\s*$")
_COND_RE2 = re.compile(r"^\s*([A-Za-z]'*)\s*\(([^()]+)\)\s*=\s*(.+?)\s*$")


def parse_conditions(conds: list[str], dep_name: str, indep_name: str):
    """解析求解条件列表, 返回 [(导数阶数, 自变量取值, 函数值), ...]。"""
    out = []
    for c in conds:
        m = _COND_RE.match(c)
        if m:
            func, var, x0s, vals = m.groups()
        else:
            m2 = _COND_RE2.match(c)
            if not m2:
                raise CalcError(
                    f"条件格式不正确: {c!r}, 应为 y'|x=0=1 或 y'(0)=1")
            func, x0s, vals = m2.groups()
            var = indep_name
        fname = func[0]
        if fname != dep_name:
            raise CalcError(f"条件中的因变量 {fname!r} 与方程因变量 {dep_name!r} 不一致")
        if var != indep_name:
            raise CalcError(f"条件中的自变量 {var!r} 与方程自变量 {indep_name!r} 不一致")
        order = func.count("'")
        x0 = _expr_of(x0s)
        val = _expr_of(vals)
        out.append((order, x0, val))
    return out


def _apply_conditions(kind, payload, conds, y, x):
    """把条件代入解, 确定任意常数。返回 (新解, 是否部分确定)。"""
    if kind == "explicit":
        expr = payload
        cs = sorted(
            {s for s in expr.free_symbols
             if isinstance(s, Symbol) and re.fullmatch(r"C\d+", s.name)},
            key=lambda s: int(s.name[1:]))
        if not cs:
            return (kind, expr), False
        eqs = []
        for order, x0, val in conds:
            d = diff(expr, x, order)
            eqs.append(Eq(d.subs(x, x0), val))
        sol = solve(eqs, cs, dict=True)
        if not sol:
            raise CalcError("条件与通解矛盾或无解, 请检查条件取值")
        s = sol[0]
        expr2 = simplify(expr.subs(s))
        rest = [c for c in cs if c not in s]
        return (("explicit", expr2), bool(rest))
    # 隐式解:仅支持单个 y(x0)=y0 条件
    lhs, rhs = payload
    if len(conds) != 1:
        raise CalcError("隐式解仅支持单个 y(x0)=y0 形式的条件")
    order, x0, val = conds[0]
    if order != 0:
        raise CalcError("隐式解仅支持 y(x0)=y0 形式的条件")
    F = lhs - rhs
    cs = [s for s in F.free_symbols
          if isinstance(s, Symbol) and re.fullmatch(r"C\d+", s.name)]
    if not cs:
        return (kind, payload), False
    solutions = solve([Eq(F.subs({x: x0, y: val}), 0)], cs, dict=True)
    if not solutions:
        raise CalcError("条件与通解矛盾或无解, 请检查条件取值")
    substitutions = solutions[0]
    new_lhs = simplify(lhs.subs(substitutions))
    new_rhs = simplify(rhs.subs(substitutions))
    remaining = any(c in (new_lhs - new_rhs).free_symbols for c in cs)
    return (("implicit", (new_lhs, new_rhs)), remaining)


# ---------------------------------------------------------------- 显示

_SUBSCR = str.maketrans("0123456789", "₀₁₂₃₄₅₆₇₈₉")


def _pretty(expr) -> str:
    s = str(expr)
    s = re.sub(r"C(\d+)", lambda m: "C" + m.group(1).translate(_SUBSCR), s)
    s = s.replace("log(", "ln(")
    return s


# ---------------------------------------------------------------- 对外接口

def solve_ode_clean(cleaned: str, dep: str, conditions: list[str] | None = None) -> str:
    """求解微分方程(清洗后)。返回展示文本。"""
    y = Symbol(dep)
    if "=" in cleaned:
        lhs_s, rhs_s = cleaned.split("=", 1)
        if "=" in rhs_s:
            raise CalcError("方程含多个等号, 请只保留一个")
        eq = _expr_of(lhs_s) - _expr_of(rhs_s)
    else:
        eq = _expr_of(cleaned)
    x = _determine_indep(eq, y)
    if x.name != "x":
        eq = eq.subs(Symbol("x"), x)
    n = _highest_order(eq, y)
    if n == 0:
        raise CalcError("未找到导数记号, 无法识别为微分方程")
    consts = _Consts()
    kind, a, b, method = _solve_ode(y, x, eq, consts)
    payload = a if kind == "explicit" else (a, b)
    conds = parse_conditions(conditions, dep, x.name) if conditions else []
    applied = False
    partial = False
    if conds:
        (kind, payload), partial = _apply_conditions(kind, payload, conds, y, x)
        applied = True
    lines = [f"解法 = {method}"]
    if kind == "explicit":
        label = "特解" if applied else "通解"
        lines.append(f"{label} = {dep} = {_pretty(payload)}")
    else:
        lhs, rhs = payload
        label = "特解" if applied else "通解"
        lines.append(f"{label} = {_pretty(lhs)} = {_pretty(rhs)}")
    if partial:
        lines.append("提示: 条件不足以确定全部任意常数, 已保留未定常数")
    return "\n".join(lines)


def compute(raw: str, conditions: list[str] | None = None) -> str:
    """主入口:输入原始表达式文本(或微分方程),返回展示文本。

    格式错误抛 CalcError,无法求出抛 TooComplexError。
    """
    try:
        cleaned, dep = _clean(raw)
        if dep is None:
            return compute_general(cleaned)
        return solve_ode_clean(cleaned, dep, conditions)
    except CalcError:
        raise
    except TooComplexError:
        raise
    except Exception as exc:
        # 其余异常统一按"过于复杂"处理(sympy 内部可能抛各种异常)
        raise TooComplexError() from exc


def classify_plot_expr(raw: str) -> tuple[object | None, list[Symbol]]:
    """兼容旧接口:绘图辅助(本子项目无绘图, 保留空实现)。"""
    return None, []
