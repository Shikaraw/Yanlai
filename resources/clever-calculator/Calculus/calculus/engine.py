"""计算引擎:表达式清洗、积分/求导解析、符号与数值计算、异常处理。

标记语法(用户可手输,UI 也会自动生成):
  不定积分  ∫(f, x)                     -> integrate(f, x)
  定积分    ∫(f, x, a, b)               -> integrate(f, (x, a, b))
  二重积分  ∫∫(f, x, a, b, y, c, d)     -> integrate(f, (x,a,b), (y,c,d))
  三重积分  ∫∫∫(f, x,a,b, y,c,d, z,e,g) -> integrate(f, (x,a,b),(y,c,d),(z,e,g))
  求导      d(f, x)  或  d(f, x, n)      -> diff(f, x) / diff(f, x, n)
  对数      log(真数, 底数) / lg(真数) / ln(真数)

多重积分按"内层到外层"排列(即数学书写 ∫∫ f dx dy 的顺序):
第一个变量对是最内层 dx,其上下限可以是外层变量的函数。
"""

from __future__ import annotations

import re

from sympy import (
    E, Derivative, Integral, N, Symbol, diff, integrate, nan, oo, simplify,
    sympify,
)
from sympy.parsing.sympy_parser import (
    implicit_multiplication_application, parse_expr, standard_transformations,
)

# 变量符号(强制为自由符号,避免与 sympy 内置函数/常量冲突)
_VARIABLES = {
    "x": Symbol("x"), "y": Symbol("y"), "z": Symbol("z"),
    "r": Symbol("r"), "t": Symbol("t"),
    "theta": Symbol("theta"), "phi": Symbol("phi"), "Phi": Symbol("Phi"),
    "alpha": Symbol("alpha"), "beta": Symbol("beta"),
}
_LOCAL_DICT = dict(_VARIABLES)
_LOCAL_DICT["e"] = E  # e 键 = 自然常数

_TRANSFORMATIONS = standard_transformations + (implicit_multiplication_application,)


class CalcError(Exception):
    """格式错误:返回"表达式格式不正确: ..."消息。"""


class TooComplexError(Exception):
    """表达式无法求出:返回"表达式过于复杂, 无法求出!"消息。"""


# ---------------------------------------------------------------- 输入清洗

def _clean(raw: str) -> str:
    """把用户友好的数学书写转换成 sympy 可解析的文本。"""
    s = raw.strip().replace("\n", "").replace("\r", "")
    if not s:
        raise CalcError("表达式为空")
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
    # (否则隐式乘法会把 sinx 拆成 s*i*n*x)
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
    return s


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

_ALLOWED_RE = re.compile(r"^[0-9A-Za-z\s+\-*/^%!(),.|\[\]{}∫]+$")


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


# ---------------------------------------------------------------- 计算核心

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
    if len(args) > 3:
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


# ---------------------------------------------------------------- 对外接口

def compute(raw: str) -> str:
    """主入口:输入原始表达式文本,返回展示文本。

    格式错误抛 CalcError,无法求出抛 TooComplexError。
    """
    try:
        cleaned = _clean(raw)
        _check_placeholders(cleaned)
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
        # 用占位 token 替换操作模板,使 ∫/d 可嵌入任意表达式(如 exp(∫...))
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
    except CalcError:
        raise
    except TooComplexError:
        raise
    except Exception as exc:
        # 其余异常统一按"过于复杂"处理(sympy 内部可能抛各种异常)
        raise TooComplexError() from exc


def classify_plot_expr(raw: str) -> tuple[object | None, list[Symbol]]:
    """绘图辅助:解析普通表达式(无积分/求导),返回 (sympy 表达式, 自由符号列表)。
    含积分/求导时返回 (None, [])。
    """
    try:
        cleaned = _clean(raw)
        _check_placeholders(cleaned)
        _check_brackets(cleaned)
        if _find_ops(cleaned):
            return None, []
        expr = _expr_of(cleaned)
        symbols = sorted(expr.free_symbols, key=lambda s: s.name)
        return expr, symbols
    except Exception:
        return None, []
