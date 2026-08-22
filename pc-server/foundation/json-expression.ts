// foundation/json-expression.ts — 余额取值表达式求值器(对齐 Android common/http/JsonExpression.kt)。
// 纪律:纯函数,零依赖,不读业务状态。供 model-providers/checks.ts 的余额取值与前端的
// resultPath 合法性校验(isJsonExprValid)共用。
//
// 支持的语法:
//   - 路径导航:  field、field.sub、array[0](缺失字段/越界索引解析为空字符串)
//   - 字符串字面量:"text",支持 \n \r \t \\ \" 转义
//   - 数字:      整数与小数(1、3.14)
//   - 一元:      +expr、-expr
//   - 算术:      + - * /(x/X 作为 * 的别名)
//   - 字符串拼接:++(操作数强转为字符串)
//   - 括号:      ( expr )
//
// 解析与强转规则:
//   - JSON 基本类型:字符串原样;数字最小化格式化(3.0 -> "3")
//   - JSON 对象/数组:以其 JSON 字符串表示返回
// 语法错误或不支持的运算符抛 ParseError。

// ── Public API ───────────────────────────────────────────────────────────────

export class ParseError extends Error {}

type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "path"; parts: PathPart[] }
  | { kind: "unary"; op: string; expr: Expr }
  | { kind: "binary"; left: Expr; op: string; right: Expr };

type PathPart = { kind: "field"; name: string } | { kind: "index"; index: number };

/** 校验表达式是否可解析,供前端/保存前红标提示用。 */
export function isJsonExprValid(input: string): boolean {
  return parseExpression(input) !== null;
}

/** 解析表达式;失败返回 null(不抛),供校验类调用。 */
function parseExpression(input: string): Expr | null {
  try {
    const lexer = new Lexer(input);
    return new Parser(lexer).parse();
  } catch {
    return null; // 解析失败属预期分支(校验/兜底),不抛
  }
}

/** 针对给定的根 JSON 值评估表达式,返回字符串结果。语法错误抛 ParseError。
 *  空表达式返回 ""(无任何字段可取,下游按「未命中」处理),对齐旧 getByPath("") 的宽容行为。 */
export function evaluateJsonExpr(input: string, root: unknown): string {
  if (!input.trim()) return "";
  const lexer = new Lexer(input);
  const expr = new Parser(lexer).parse();
  const value = evalExpr(expr, root);
  return typeof value === "string" ? value : formatNumber(value);
}

// ── Lexer ────────────────────────────────────────────────────────────────────

type Token = { type: TokType; lexeme: string };
// 用普通 string 枚举而非 const enum:本模块同时被 bun test(bun 自转译)与 bun build --compile
// 打包,普通枚举在两种转译器下行为一致,消除 const enum 内联差异的任何隐患。成员量小,零开销。
enum TokType {
  Ident = "Ident",
  Number = "Number",
  String = "String",
  Dot = "Dot",
  LBracket = "LBracket",
  RBracket = "RBracket",
  LParen = "LParen",
  RParen = "RParen",
  Plus = "Plus",
  Minus = "Minus",
  Star = "Star",
  Slash = "Slash",
  Concat = "Concat",
  Eof = "Eof",
}

class Lexer {
  private i = 0;
  constructor(private src: string) {}

  next(): Token {
    this.skipWhitespace();
    if (this.i >= this.src.length) return { type: TokType.Eof, lexeme: "" };
    const c = this.src[this.i];
    switch (c) {
      case ".": this.i++; return { type: TokType.Dot, lexeme: "." };
      case "[": this.i++; return { type: TokType.LBracket, lexeme: "[" };
      case "]": this.i++; return { type: TokType.RBracket, lexeme: "]" };
      case "(": this.i++; return { type: TokType.LParen, lexeme: "(" };
      case ")": this.i++; return { type: TokType.RParen, lexeme: ")" };
      case "+":
        if (this.peek() === "+") { this.i += 2; return { type: TokType.Concat, lexeme: "++" }; }
        this.i++; return { type: TokType.Plus, lexeme: "+" };
      case "-": this.i++; return { type: TokType.Minus, lexeme: "-" };
      case "*": this.i++; return { type: TokType.Star, lexeme: "*" };
      case "/": this.i++; return { type: TokType.Slash, lexeme: "/" };
      case "x":
      case "X": this.i++; return { type: TokType.Star, lexeme: c };
      case '"': return this.stringToken();
    }
    if (isDigit(c)) return this.numberToken();
    if (isIdentStart(c)) return this.identToken();
    throw new ParseError(`Unexpected character '${c}' at ${this.i}`);
  }

  private skipWhitespace() {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
  }

  private stringToken(): Token {
    const start = this.i;
    this.i++; // skip opening quote
    let sb = "";
    let escaped = false;
    let terminated = false;
    while (this.i < this.src.length) {
      const ch = this.src[this.i];
      this.i++;
      if (escaped) {
        switch (ch) {
          case "\\": sb += "\\"; break;
          case '"': sb += '"'; break;
          case "n": sb += "\n"; break;
          case "r": sb += "\r"; break;
          case "t": sb += "\t"; break;
          default: sb += ch;
        }
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        terminated = true;
        break;
      } else {
        sb += ch;
      }
    }
    if (!terminated) throw new ParseError(`Unterminated string starting at ${start}`);
    return { type: TokType.String, lexeme: sb };
  }

  private numberToken(): Token {
    const start = this.i;
    while (this.i < this.src.length && isDigit(this.src[this.i])) this.i++;
    if (this.i < this.src.length && this.src[this.i] === ".") {
      this.i++;
      while (this.i < this.src.length && isDigit(this.src[this.i])) this.i++;
    }
    return { type: TokType.Number, lexeme: this.src.substring(start, this.i) };
  }

  private identToken(): Token {
    const start = this.i;
    this.i++;
    while (this.i < this.src.length && isIdentPart(this.src[this.i])) this.i++;
    return { type: TokType.Ident, lexeme: this.src.substring(start, this.i) };
  }

  private peek(): string | null {
    return this.i + 1 < this.src.length ? this.src[this.i + 1] : null;
  }
}

function isDigit(c: string) { return c >= "0" && c <= "9"; }
function isIdentStart(c: string) { return c === "_" || /[A-Za-z]/.test(c); }
function isIdentPart(c: string) { return c === "_" || /[A-Za-z0-9]/.test(c); }

// ── Parser(优先级:concat > additive > multiplicative > unary > primary)──────────

class Parser {
  private current: Token;
  private last: Token;
  constructor(private lexer: Lexer) {
    this.current = lexer.next();
    this.last = this.current;
  }

  parse(): Expr {
    const expr = this.parseConcat();
    this.expect(TokType.Eof);
    return expr;
  }

  private parseConcat(): Expr {
    let expr = this.parseAdditive();
    while (this.match(TokType.Concat)) {
      const op = this.previous();
      const right = this.parseAdditive();
      expr = { kind: "binary", left: expr, op: op.lexeme, right };
    }
    return expr;
  }

  private parseAdditive(): Expr {
    let expr = this.parseMultiplicative();
    while (this.match(TokType.Plus) || this.match(TokType.Minus)) {
      const op = this.previous();
      const right = this.parseMultiplicative();
      expr = { kind: "binary", left: expr, op: op.lexeme, right };
    }
    return expr;
  }

  private parseMultiplicative(): Expr {
    let expr = this.parseUnary();
    while (this.match(TokType.Star) || this.match(TokType.Slash)) {
      const op = this.previous();
      const right = this.parseUnary();
      expr = { kind: "binary", left: expr, op: op.lexeme, right };
    }
    return expr;
  }

  private parseUnary(): Expr {
    if (this.match(TokType.Plus) || this.match(TokType.Minus)) {
      const op = this.previous();
      const right = this.parseUnary();
      return { kind: "unary", op: op.lexeme, expr: right };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    switch (this.current.type) {
      case TokType.Number: {
        const n = this.current;
        this.advance();
        return { kind: "num", value: Number.parseFloat(n.lexeme) };
      }
      case TokType.String: {
        const s = this.current;
        this.advance();
        return { kind: "str", value: s.lexeme };
      }
      case TokType.Ident:
        return this.parsePath();
      case TokType.LParen: {
        this.advance();
        const e = this.parseConcat();
        this.expect(TokType.RParen);
        return e;
      }
      default:
        throw new ParseError(`Expected primary expression, got ${TokType[this.current.type]}`);
    }
  }

  private parsePath(): Expr {
    const parts: PathPart[] = [];
    if (this.current.type !== TokType.Ident) throw new ParseError("Expected identifier for path");
    parts.push({ kind: "field", name: this.current.lexeme });
    this.advance();
    for (;;) {
      if (this.match(TokType.Dot)) {
        const idTok = this.expect(TokType.Ident);
        parts.push({ kind: "field", name: idTok.lexeme });
      } else if (this.match(TokType.LBracket)) {
        const numTok = this.expect(TokType.Number);
        const idx = Math.trunc(Number.parseFloat(numTok.lexeme));
        parts.push({ kind: "index", index: idx });
        this.expect(TokType.RBracket);
      } else {
        break;
      }
    }
    return { kind: "path", parts };
  }

  private match(type: TokType): boolean {
    if (this.current.type === type) { this.advance(); return true; }
    return false;
  }

  private expect(type: TokType): Token {
    if (this.current.type !== type) {
      throw new ParseError(`Expected ${TokType[type]} but got ${TokType[this.current.type]}`);
    }
    const tok = this.current;
    this.advance();
    return tok;
  }

  private advance() { this.last = this.current; this.current = this.lexer.next(); }
  private previous(): Token { return this.last; }
}

// ── Evaluator ────────────────────────────────────────────────────────────────

type Value = string | number;

function evalExpr(expr: Expr, root: unknown): Value {
  switch (expr.kind) {
    case "num": return expr.value;
    case "str": return expr.value;
    case "path": return fromJson(resolvePath(expr.parts, root));
    case "unary": {
      const v = evalExpr(expr.expr, root);
      return expr.op === "-" ? -toNumber(v) : +toNumber(v);
    }
    case "binary": {
      const left = evalExpr(expr.left, root);
      const right = evalExpr(expr.right, root);
      switch (expr.op) {
        case "++": return toStr(left) + toStr(right);
        case "+": return toNumber(left) + toNumber(right);
        case "-": return toNumber(left) - toNumber(right);
        case "*": case "x": case "X": return toNumber(left) * toNumber(right);
        case "/": return toNumber(left) / toNumber(right);
        default: throw new ParseError(`Unsupported binary operator ${expr.op}`);
      }
    }
  }
}

function resolvePath(parts: PathPart[], root: unknown): unknown {
  let cur: unknown = root;
  for (const part of parts) {
    if (part.kind === "field") {
      if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[part.name];
      if (cur === undefined) return undefined;
    } else {
      if (!Array.isArray(cur)) return undefined;
      const idx = part.index;
      if (idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    }
  }
  return cur;
}

function fromJson(elem: unknown): Value {
  if (elem === null || elem === undefined) return "";
  if (typeof elem === "string") return elem;
  if (typeof elem === "number") {
    // 对齐 Android:先两位小数再化简("0.00"->0->"0",3.5->3.5)
    return Number(elem.toFixed(2));
  }
  if (typeof elem === "boolean") return String(elem);
  if (typeof elem === "object") return JSON.stringify(elem);
  return String(elem);
}

function toNumber(v: Value): number {
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toStr(v: Value): string {
  return typeof v === "number" ? formatNumber(v) : v;
}

function formatNumber(d: number): string {
  if (Number.isNaN(d) || !Number.isFinite(d)) return String(d);
  return String(d);
}
