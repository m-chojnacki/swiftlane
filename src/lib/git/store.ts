import { SwiftlaneError } from '../errors.ts';
import { type RunOptions, run } from '../exec.ts';
import { log } from '../log.ts';

export const STORE_REF = 'refs/certs/swiftlane';
const ENTRY_NAME = /^[A-Za-z0-9._-]+$/;
const MAX_PUSH_ATTEMPTS = 4;

export interface StoreOptions {
  /** Remote name or URL, defaults to "origin" (or the only configured remote). */
  remote?: string;
  /** Token used for HTTPS remotes instead of the system git credentials. */
  token?: string;
  cwd?: string;
}

export interface Snapshot {
  /** Commit the remote ref pointed at when read, `null` when the ref does not exist. */
  commit: string | null;
  entries: Map<string, string>;
}

/** Returns the new entries, or `undefined` to leave the ref untouched. Empty entries delete the ref. */
export type Mutation = (entries: Map<string, string>, commit: string | null) => Map<string, string> | undefined;

class LeaseRejectedError extends SwiftlaneError {}

const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'swiftlane',
  GIT_AUTHOR_EMAIL: 'swiftlane@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'swiftlane',
  GIT_COMMITTER_EMAIL: 'swiftlane@users.noreply.github.com',
};

/** git@host:owner/repo.git and ssh://git@host/owner/repo.git become https://host/owner/repo.git */
export function toHttpsUrl(url: string): string | undefined {
  if (/^https?:\/\//.test(url)) return url.replace(/^(https?:\/\/)[^@/]*@/, '$1');
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url);
  if (scp && !url.includes('://')) return `https://${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return undefined;
}

/**
 * Key-value storage of encrypted signing keys in a hidden ref of the project repository.
 * Every write is a fresh parentless commit, so the ref never accumulates history of old keys.
 */
export class CertificateStore {
  readonly #options: StoreOptions;
  #target: { remote: string; display: string; config: string[]; secrets: string[] } | undefined;

  constructor(options: StoreOptions = {}) {
    this.#options = options;
  }

  async #git(args: string[], options: RunOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const target = await this.#resolveTarget();
    return run('git', [...target.config, ...args], {
      cwd: this.#options.cwd,
      ...options,
      // Never hang a CI job on an interactive credentials prompt.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...options.env },
      secrets: [...target.secrets, ...(options.secrets ?? [])],
    });
  }

  async #resolveTarget(): Promise<{ remote: string; display: string; config: string[]; secrets: string[] }> {
    if (this.#target) return this.#target;
    const cwd = this.#options.cwd;
    const inside = await run('git', ['rev-parse', '--git-dir'], { cwd, allowFailure: true });
    if (inside.code !== 0) {
      throw new SwiftlaneError('Not inside a git repository', {
        hint: `Run swiftlane from your project checkout, signing keys are stored in its remote under ${STORE_REF}`,
      });
    }

    let remote = this.#options.remote;
    if (!remote) {
      const remotes = (await run('git', ['remote'], { cwd })).stdout.split('\n').filter(Boolean);
      remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined;
      if (!remote) {
        throw new SwiftlaneError(
          remotes.length === 0 ? 'The repository has no remotes' : `Cannot pick a default remote among: ${remotes.join(', ')}`,
          {
            hint: 'Pass -o / --origin with a remote name or URL',
          },
        );
      }
    }

    const named = await run('git', ['remote', 'get-url', remote], { cwd, allowFailure: true });
    const isUrl = named.code !== 0;
    if (isUrl && !/[:/@]/.test(remote)) {
      throw new SwiftlaneError(`Unknown git remote "${remote}"`, { hint: 'Pass -o / --origin with a remote name or URL' });
    }
    const url = isUrl ? remote : named.stdout.trim();

    const token = this.#options.token;
    if (!token) {
      this.#target = { remote, display: isUrl ? (toHttpsUrl(remote) ?? remote) : remote, config: [], secrets: [] };
      return this.#target;
    }

    const httpsUrl = toHttpsUrl(url);
    if (!httpsUrl) {
      throw new SwiftlaneError(`Cannot use a token with remote URL ${url}`, {
        hint: 'Use an HTTPS or SSH GitHub remote, or omit -g / --github-token',
      });
    }
    const { origin } = new URL(httpsUrl);
    const credentials = Buffer.from(`x-access-token:${token}`).toString('base64');
    // Same mechanism as actions/checkout. Clearing the URL-scoped header first prevents sending
    // two Authorization headers when checkout already persisted its own token.
    const key = `http.${origin}/.extraheader`;
    this.#target = {
      remote: httpsUrl,
      display: httpsUrl,
      config: ['-c', `${key}=`, '-c', `${key}=AUTHORIZATION: basic ${credentials}`],
      secrets: [token, credentials],
    };
    return this.#target;
  }

  async describe(): Promise<string> {
    return (await this.#resolveTarget()).display;
  }

  async #remoteCommit(): Promise<string | null> {
    const { remote } = await this.#resolveTarget();
    const result = await this.#git(['ls-remote', '--refs', remote, STORE_REF], {
      hint: 'Check that the remote exists and that git can authenticate (system credentials or -g / --github-token)',
    });
    const line = result.stdout.split('\n').find((entry) => entry.endsWith(`\t${STORE_REF}`));
    return line ? line.split('\t')[0]! : null;
  }

  async read(): Promise<Snapshot> {
    const entries = new Map<string, string>();
    if (!(await this.#remoteCommit())) {
      await this.#git(['update-ref', '-d', STORE_REF], { allowFailure: true });
      return { commit: null, entries };
    }

    const { remote } = await this.#resolveTarget();
    await this.#git(['fetch', '--no-tags', '--no-write-fetch-head', '--quiet', remote, `+${STORE_REF}:${STORE_REF}`]);
    // The ref may have moved since ls-remote, so the lease must use exactly what was fetched.
    const commit = (await this.#git(['rev-parse', '--verify', `${STORE_REF}^{commit}`])).stdout.trim();
    const tree = await this.#git(['ls-tree', '-z', commit]);
    for (const record of tree.stdout.split('\0').filter(Boolean)) {
      const [meta, name] = record.split('\t') as [string, string];
      const [, type, object] = meta.split(' ');
      if (type !== 'blob' || !ENTRY_NAME.test(name)) {
        log.debug(`Ignoring unexpected ${type} "${name}" in ${STORE_REF}`);
        continue;
      }
      entries.set(name, (await this.#git(['cat-file', 'blob', object!])).stdout);
    }
    return { commit, entries };
  }

  async #createCommit(entries: Map<string, string>): Promise<string> {
    const lines: string[] = [];
    for (const [name, contents] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
      if (!ENTRY_NAME.test(name)) throw new SwiftlaneError(`Invalid entry name "${name}"`);
      const blob = (await this.#git(['hash-object', '-w', '--stdin'], { input: contents })).stdout.trim();
      lines.push(`100644 blob ${blob}\t${name}`);
    }
    const tree = (await this.#git(['mktree'], { input: lines.length ? `${lines.join('\n')}\n` : '' })).stdout.trim();
    const message = `swiftlane signing keys (${entries.size} ${entries.size === 1 ? 'entry' : 'entries'})`;
    return (await this.#git(['commit-tree', '--no-gpg-sign', tree, '-m', message], { env: COMMIT_IDENTITY })).stdout.trim();
  }

  async #push(source: string, expected: string | null): Promise<void> {
    const { remote } = await this.#resolveTarget();
    const result = await this.#git(
      ['push', '--no-verify', '--porcelain', `--force-with-lease=${STORE_REF}:${expected ?? ''}`, remote, `${source}:${STORE_REF}`],
      { allowFailure: true },
    );
    if (result.code === 0) return;
    const output = `${result.stdout}\n${result.stderr}`;
    if (/stale info|fetch first|non-fast-forward|\[rejected\]/.test(output)) {
      throw new LeaseRejectedError(`${STORE_REF} changed on the remote while updating it`);
    }
    throw new SwiftlaneError(`Could not push ${STORE_REF}:\n${result.stderr.trim()}`, {
      hint: 'Make sure the git credentials (or -g / --github-token) can push to the repository, e.g. `contents: write` permission in GitHub Actions',
    });
  }

  /** Fails early, before anything is created in App Store Connect, if the ref cannot be written later. */
  async assertWritable(): Promise<void> {
    const { remote } = await this.#resolveTarget();
    const probe = await this.#createCommit(new Map());
    const result = await this.#git(['push', '--dry-run', '--no-verify', '--force', remote, `${probe}:${STORE_REF}`], {
      allowFailure: true,
    });
    if (result.code !== 0) {
      throw new SwiftlaneError(`No write access to ${await this.describe()}:\n${result.stderr.trim()}`, {
        hint: `Signing keys are pushed to ${STORE_REF}. Grant push access (GitHub Actions: \`permissions: contents: write\`) or pass -g / --github-token`,
      });
    }
  }

  /**
   * Applies the mutation to the current remote state and pushes it. When another job
   * updates the ref concurrently the push lease fails and the mutation is re-applied on fresh state.
   */
  async update(mutate: Mutation): Promise<Snapshot> {
    for (let attempt = 1; ; attempt++) {
      const snapshot = await this.read();
      const next = mutate(new Map(snapshot.entries), snapshot.commit);
      if (!next) return snapshot;
      try {
        if (next.size === 0) {
          if (snapshot.commit) {
            await this.#push('', snapshot.commit);
            await this.#git(['update-ref', '-d', STORE_REF], { allowFailure: true });
          }
          return { commit: null, entries: next };
        }
        const commit = await this.#createCommit(next);
        await this.#push(commit, snapshot.commit);
        await this.#git(['update-ref', STORE_REF, commit]);
        return { commit, entries: next };
      } catch (error) {
        if (!(error instanceof LeaseRejectedError) || attempt >= MAX_PUSH_ATTEMPTS) throw error;
        log.warn(`${error.message}, retrying with fresh state (attempt ${attempt + 1}/${MAX_PUSH_ATTEMPTS})`);
      }
    }
  }

  async drop(): Promise<boolean> {
    let existed = false;
    await this.update((_, commit) => {
      existed = commit !== null;
      return existed ? new Map() : undefined;
    });
    return existed;
  }
}
