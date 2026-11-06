/**
 * windows 平台分支（bun exe）：Bun 运行时下的 `node:sqlite` 兼容层。
 *
 * 背景：Node 24 内置 `node:sqlite`（项目 `src/db.js` 的唯一 SQLite 入口），
 * 但 Bun（1.4.x 及更早，包括 `bun build --compile` 生成的 exe）没有实现
 * `node:sqlite`，只提供 `bun:sqlite`。为了让同一份代码在 Node 与 Bun exe
 * 中都能运行，这里用 `bun:sqlite` 实现项目实际用到的 `DatabaseSync` /
 * `StatementSync` 子集：
 *
 *   new DatabaseSync(path)   -> new Database(path)
 *   db.exec(sql)             -> db.exec(sql)（支持多条语句）
 *   db.prepare(sql)          -> Statement 包装（all/get/run）
 *   db.close()
 *
 * 语义差异尽量贴近 node:sqlite：`run()` 返回 `{ changes, lastInsertRowid }`，
 * `get()` 返回对象或 undefined，`all()` 返回数组。未使用到的 API（columns /
 * iterate / session 等）不实现——需要时再补，不要静默返回错误数据。
 *
 * 注意：本模块只能在 Bun 运行时加载；Node 下由 `src/db.js` 直接使用原生
 * `node:sqlite`，不会 import 这里。
 */
import { Database } from 'bun:sqlite';

/** 把 bun:sqlite 的 Statement 包装成 node:sqlite 风格的 StatementSync。 */
class BunStatementSync {
  constructor(statement) {
    this._statement = statement;
  }

  all(...params) {
    return this._statement.all(...params);
  }

  get(...params) {
    return this._statement.get(...params);
  }

  run(...params) {
    const result = this._statement.run(...params);
    return {
      changes: result?.changes ?? 0,
      lastInsertRowid: result?.lastInsertRowid ?? 0
    };
  }
}

/**
 * `node:sqlite` 的 DatabaseSync 兼容实现（基于 bun:sqlite）。
 * 只覆盖项目实际使用的选项：`open=false` 时抛错（node:sqlite 语义是打开失败），
 * `readOnly` 透传；其余选项忽略。
 */
export class DatabaseSync {
  constructor(location, options = {}) {
    if (options.open === false) {
      throw new Error(`SQLite database is not open: ${String(location)}`);
    }
    this._db = new Database(String(location), {
      create: options.readOnly !== true,
      readonly: options.readOnly === true
    });
  }

  exec(sql) {
    this._db.exec(String(sql));
  }

  prepare(sql) {
    return new BunStatementSync(this._db.prepare(String(sql)));
  }

  close() {
    this._db.close();
  }
}

export default DatabaseSync;
