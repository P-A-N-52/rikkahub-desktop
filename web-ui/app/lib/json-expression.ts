// lib/json-expression.ts — 余额取值表达式的轻量合法性校验器。
//
// 与后端 pc-server/foundation/json-expression.ts 的 isJsonExprValid 保持行为一致(手动同步,
// 两端无编译期链接,改一侧须同步另一侧)。仅做「能否解析」的判定,不求值——求值由后端做。
// 语法:路径 a.b / a[0]、数字、"字符串"、一元 ±、+ - * /(x 别名)、拼接 ++、括号。

export function isBalanceResultPathValid(input: string): boolean {
  return tryParse(input.trim());
}

// 简化解析器:只需判定合法性,不构造语法树。与后端 Parser 的优先级层级一致:
// concat > additive > multiplicative > unary > primary。解析失败抛错,外层 tryParse 捕获。
function tryParse(src: string): boolean {
  try {
    const p = new ExprValidator(src);
    p.parse();
    return true;
  } catch {
    return false; // 非法表达式是预期分支,不抛
  }
}

enum T {
  Ident, Number, String, Dot, LBracket, RBracket, LParen, RParen, Plus, Minus, Star, Slash, Concat, Eof,
}
type Tok = { t: T; s: string };

class ExprValidator {
  private i = 0;
  private cur: Tok;
  constructor(private src: string) {
    this.cur = this.next();
  }

  parse(): void {
    this.concat();
    this.expect(T.Eof);
  }

  private concat(): void {
    this.additive();
    while (this.match(T.Concat)) this.additive();
  }
  private additive(): void {
    this.multiplicative();
    while (this.match(T.Plus) || this.match(T.Minus)) this.multiplicative();
  }
  private multiplicative(): void {
    this.unary();
    while (this.match(T.Star) || this.match(T.Slash)) this.unary();
  }
  private unary(): void {
    if (this.match(T.Plus) || this.match(T.Minus)) return this.unary();
    this.primary();
  }
  private primary(): void {
    if (this.match(T.Number) || this.match(T.String)) return;
    if (this.cur.t === T.Ident) return this.path();
    if (this.match(T.LParen)) { this.concat(); this.expect(T.RParen); return; }
    throw new Error("expected primary");
  }
  private path(): void {
    this.expect(T.Ident);
    for (;;) {
      if (this.match(T.Dot)) { this.expect(T.Ident); continue; }
      if (this.match(T.LBracket)) { this.expect(T.Number); this.expect(T.RBracket); continue; }
      break;
    }
  }

  private match(t: T): boolean {
    if (this.cur.t === t) { this.cur = this.next(); return true; }
    return false;
  }
  private expect(t: T): Tok {
    if (this.cur.t !== t) throw new Error(`expected ${t}`);
    const tok = this.cur;
    this.cur = this.next();
    return tok;
  }

  private next(): Tok {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
    if (this.i >= this.src.length) return { t: T.Eof, s: "" };
    const c = this.src[this.i];
    switch (c) {
      case ".": this.i++; return { t: T.Dot, s: "." };
      case "[": this.i++; return { t: T.LBracket, s: "[" };
      case "]": this.i++; return { t: T.RBracket, s: "]" };
      case "(": this.i++; return { t: T.LParen, s: "(" };
      case ")": this.i++; return { t: T.RParen, s: ")" };
      case "+":
        if (this.src[this.i + 1] === "+") { this.i += 2; return { t: T.Concat, s: "++" }; }
        this.i++; return { t: T.Plus, s: "+" };
      case "-": this.i++; return { t: T.Minus, s: "-" };
      case "*": this.i++; return { t: T.Star, s: "*" };
      case "/": this.i++; return { t: T.Slash, s: "/" };
      case "x":
      case "X": this.i++; return { t: T.Star, s: c };
      case '"': return this.stringTok();
    }
    if (c >= "0" && c <= "9") return this.numberTok();
    if (c === "_" || /[A-Za-z]/.test(c)) return this.identTok();
    throw new Error(`unexpected char '${c}'`);
  }

  private stringTok(): Tok {
    this.i++; // opening quote
    let escaped = false;
    let terminated = false;
    while (this.i < this.src.length) {
      const ch = this.src[this.i];
      this.i++;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') { terminated = true; break; }
    }
    if (!terminated) throw new Error("unterminated string");
    return { t: T.String, s: "" };
  }
  private numberTok(): Tok {
    while (this.i < this.src.length && this.src[this.i] >= "0" && this.src[this.i] <= "9") this.i++;
    if (this.src[this.i] === ".") {
      this.i++;
      while (this.i < this.src.length && this.src[this.i] >= "0" && this.src[this.i] <= "9") this.i++;
    }
    return { t: T.Number, s: "" };
  }
  private identTok(): Tok {
    this.i++;
    while (this.i < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.i])) this.i++;
    return { t: T.Ident, s: "" };
  }
}
