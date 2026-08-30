// PostgreSQL adapter — composed from focused domain modules in this folder.
//
// The class previously lived in a single ~2800-line `database-postgresql.ts`
// file. It is now split by domain for easier debugging and development while
// preserving the exact public surface: `new (default)()` yields one instance
// exposing every `db.*` method, with the identical SQL/logic (moved verbatim).
//
// Layout:
//   core.ts    connection lifecycle, config, query(), close()   (DatabaseCore)
//   schema.ts  createTables() DDL + default season bootstrap
//   players.ts seasons.ts matches.ts rankings.ts users.ts
//   devices.ts data.ts images.ts cups.ts backup.ts
//
// Each domain module exports a class extending DatabaseCore whose methods
// operate on `this` (resolving `this.query` / `this.pool` / `this.config` via
// inheritance). index.ts copies every domain's prototype methods onto the
// composed class's prototype so one instance carries the full surface, then
// merges the per-domain types back onto the class so
// `new TennisDatabasePostgreSQL()` stays fully typed for callers.

import { DatabaseCore } from './core.js'
import { SchemaMethods } from './schema.js'
import { PlayersMethods } from './players.js'
import { SeasonsMethods } from './seasons.js'
import { MatchesMethods } from './matches.js'
import { RankingsMethods } from './rankings.js'
import { UsersMethods } from './users.js'
import { DevicesMethods } from './devices.js'
import { DataMethods } from './data.js'
import { ImagesMethods } from './images.js'
import { CupsMethods } from './cups.js'
import { BackupMethods } from './backup.js'

class TennisDatabasePostgreSQL extends DatabaseCore {
  constructor() {
    super()
  }
}

// Copy each domain class's own prototype members onto the composed prototype.
// Class methods are non-enumerable, so Object.assign would skip them — we copy
// the descriptors explicitly. A single instance then exposes the full `db.*`
// API, with each method's `this.query` / `this.pool` / `this.config` resolving
// through the DatabaseCore prototype chain.
const copyOwn = (src: object, dst: object): void => {
  for (const key of Object.getOwnPropertyNames(src)) {
    if (key === 'constructor') continue
    Object.defineProperty(dst, key, Object.getOwnPropertyDescriptor(src, key)!)
  }
}
const domains = [
  SchemaMethods,
  PlayersMethods,
  SeasonsMethods,
  MatchesMethods,
  RankingsMethods,
  UsersMethods,
  DevicesMethods,
  DataMethods,
  ImagesMethods,
  CupsMethods,
  BackupMethods,
] as const
for (const Domain of domains) {
  copyOwn(Domain.prototype, TennisDatabasePostgreSQL.prototype)
}

// Merge the domain method signatures onto the instance type so the public
// `db.<method>()` calls remain statically typed (autocomplete + misuse checks).
interface TennisDatabasePostgreSQL
  extends SchemaMethods,
    PlayersMethods,
    SeasonsMethods,
    MatchesMethods,
    RankingsMethods,
    UsersMethods,
    DevicesMethods,
    DataMethods,
    ImagesMethods,
    CupsMethods,
    BackupMethods {}

export default TennisDatabasePostgreSQL
export { TennisDatabasePostgreSQL }