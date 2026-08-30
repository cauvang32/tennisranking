import { DatabaseCore } from './core.js'
import { spawn } from 'node:child_process'
import { createWriteStream, createReadStream } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import config from '../../config/env.js'

export class BackupMethods extends DatabaseCore {
  // ── Database file backup/restore (pg_dump / pg_restore) ─────────────────
  // pg_dump and pg_restore live in the Postgres container, not on the host, so
  // we shell out via 'docker exec' (no --privileged, no docker-socket mount —
  // we only run tools that already exist inside the image). The backup file is
  // a self-describing custom-format (.dump) archive: restoring it into a blank
  // database recreates schema (tables, indexes, triggers, sequences) AND data,
  // so a brand-new host needs no manual migration step.
  _runDockerDbTool(args: string[], onStdout?: (chunk: Buffer) => void, timeoutMs = 120000): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      // spawn, NOT execFile: execFile buffers stdout internally, and with
      // maxBuffer: 0 it silently drops bytes as soon as the child writes —
      // that truncated pg_dump output (and the resulting corrupt archive
      // made pg_restore segfault). spawn's 'pipe' is unbuffered.
      const child = spawn('docker', ['exec', '-i', config.postgresContainer, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      })
      const timer = setTimeout(() => { child.kill() }, timeoutMs)
      let stderr = ''
      child.stdout.on('data', chunk => { if (onStdout) onStdout(chunk) })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('error', err => { clearTimeout(timer); rejectPromise(new Error('Failed to run docker exec: ' + err.message)) })
      child.on('close', code => {
        clearTimeout(timer)
        if (code === 0) resolvePromise()
        else rejectPromise(new Error('docker exec ' + args[2] + ' exited with code ' + code + ': ' + stderr.trim().slice(0, 500)))
      })
    })
  }


  // Full database dump to a file on the host (custom format, self-describing).
  // pg_dump must stream to STDOUT: with '-f' the archive lands in the container
  // filesystem and stdout is empty, producing a 0-byte host file. The custom
  // format is self-contained, so the byte stream can be written straight to disk.
  async dumpDatabase(filePath: string): Promise<void> {
    await mkdir(join(filePath, '..'), { recursive: true })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const out = createWriteStream(filePath)
      out.on('error', err => rejectPromise(new Error('Failed to write dump file: ' + err.message)))
      this._runDockerDbTool(['pg_dump', '-U', this.config.user, '-d', this.config.database, '-Fc'], chunk => {
        out.write(chunk)
      }).then(() => out.end(err => err ? rejectPromise(err) : resolvePromise())).catch(rejectPromise)
    })
  }


  // Run a one-off psql command inside the Postgres container. Defaults to the
  // 'postgres' maintenance database — CREATE/DROP DATABASE cannot run against a
  // connected database.
  _runPsql(args: string[], database?: string, timeoutMs = 120000): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('docker', ['exec', '-i', config.postgresContainer, 'psql', '-U', this.config.user, '-v', 'ON_ERROR_STOP=1', '-d', database || 'postgres', '-t', '-A', '-c', args.join(' ')], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      })
      const timer = setTimeout(() => { child.kill() }, timeoutMs)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('error', err => { clearTimeout(timer); rejectPromise(new Error('Failed to run docker exec: ' + err.message)) })
      child.on('close', code => {
        clearTimeout(timer)
        resolvePromise({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() })
      })
    })
  }


  // Verify a backup archive BEFORE any destructive step: restore it into a
  // throwaway scratch database with the SAME flags the real restore uses,
  // require at least one table to come back, then drop the scratch DB.
  // pg_restore SEGFAULTS (exit 139) on truncated custom-format archives
  // instead of reporting an error, so a corrupt upload must be caught before
  // we touch the real database. Using PostgreSQL itself as the validator
  // avoids hand-parsing the binary archive format.
  async testDumpArchive(filePath: string): Promise<string | null> {
    const scratch = 'tennis_restore_test_' + Date.now()
    try {
      const created = await this._runPsql(['CREATE DATABASE ' + scratch])
      if (created.code !== 0) return 'could not create scratch test database: ' + created.stderr.slice(0, 300)

      const restoreResult = await new Promise<number>(resolvePromise => {
        const child = spawn('docker', ['exec', '-i', config.postgresContainer, 'pg_restore', '-U', this.config.user, '-d', scratch, '--no-owner', '--no-privileges', '--clean', '--if-exists', '--disable-triggers', '--single-transaction'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false
        })
        const timer = setTimeout(() => { child.kill() }, 300000)
        const input = createReadStream(filePath)
        input.on('error', () => { clearTimeout(timer); child.kill(); resolvePromise(-1) })
        input.pipe(child.stdin)
        child.on('error', () => { clearTimeout(timer); resolvePromise(-1) })
        child.on('close', code => { clearTimeout(timer); resolvePromise(code ?? -1) })
      })
      if (restoreResult !== 0) {
        return 'pg_restore failed on the test database (exit ' + restoreResult + '). The archive is corrupt or incomplete.'
      }

      // Require at least one table actually landed — a truncated archive can
      // surface as a non-fatal pg_restore error while restoring nothing.
      const tables = await this._runPsql(['SELECT count(*) FROM pg_tables WHERE schemaname = \'public\''], scratch)
      if (tables.code !== 0) return 'scratch table check failed: ' + tables.stderr.slice(0, 300)
      const tableCount = Number(String(tables.stdout).trim() || 0)
      if (tableCount < 1) return 'pg_restore finished but restored no tables; the archive appears empty or corrupt'
      return null
    } finally {
      await this._runPsql(['DROP DATABASE IF EXISTS ' + scratch]).catch(() => { })
    }
  }


  // Restore a custom-format dump into the database. The dump is
  // self-describing, so the restore REPLACES every table: pg_restore --clean
  // drops each object before recreating it, and the whole thing runs in a
  // SINGLE transaction — on any failure it rolls back and the pre-restore
  // data stays intact (no "cleared but half-restored" state). --disable-triggers
  // stops the stats triggers on 'matches' from firing mid-restore and corrupting
  // the stats tables the archive also carries (allowed: the app role is
  // superuser and owns all tables). pg_restore reads the archive from STDIN
  // (no filename given) — the host dump file is piped through 'docker exec -i'.
  // The handler must call testDumpArchive() first and refuse to proceed on failure.
  async restoreDatabase(filePath: string): Promise<string | null> {
    return new Promise<string | null>((resolvePromise, rejectPromise) => {
      const child = spawn('docker', ['exec', '-i', config.postgresContainer, 'pg_restore', '-U', this.config.user, '-d', this.config.database, '--no-owner', '--no-privileges', '--clean', '--if-exists', '--disable-triggers', '--single-transaction'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      })
      const timer = setTimeout(() => { child.kill() }, 300000)
      const input = createReadStream(filePath)
      input.on('error', err => { clearTimeout(timer); child.kill(); rejectPromise(new Error('Failed to read dump file: ' + err.message)) })
      input.pipe(child.stdin)
      let stderr = ''
      child.stdout.on('data', () => {})
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('error', err => { clearTimeout(timer); rejectPromise(new Error('Failed to run docker exec: ' + err.message)) })
      child.on('close', code => {
        clearTimeout(timer)
        // With --single-transaction the restore is all-or-nothing: any error
        // aborts the whole transaction and rolls back. So exit code 1 (which
        // pg_restore also uses for "completed with errors") must be treated
        // as FAILURE, never silently accepted — otherwise a partial restore
        // is reported as success and data is quietly missing.
        if (code === 0) resolvePromise(stderr.trim().slice(0, 1000) || null)
        else rejectPromise(new Error('pg_restore exited with code ' + code + ' (rolled back): ' + stderr.trim().slice(0, 500)))
      })
    })
  }


}
