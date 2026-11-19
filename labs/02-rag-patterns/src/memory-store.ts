import type { CacheStore } from './semantic-cache.js';

/**
 * `CacheStore` em memória, para os testes rodarem sem Redis.
 *
 * O MATCH segue as regras de glob do Redis (`*` e `?`) de propósito. Um padrão montado com
 * entrada de usuário sem tratamento casaria com as chaves de outras pessoas, e é com este
 * store que o teste pega esse erro. Um `startsWith` simples deixaria passar.
 */
export function createMemoryStore() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();

  const globToRegExp = (pattern: string) =>
    new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
    );

  const store: CacheStore = {
    async set(key, value, options) {
      data.set(key, value);
      ttls.set(key, options.expiration.value);
    },
    async mGet(keys) {
      return keys.map((key) => data.get(key) ?? null);
    },
    async *scanIterator({ MATCH }) {
      const pattern = globToRegExp(MATCH);
      yield [...data.keys()].filter((key) => pattern.test(key));
    },
  };

  return { store, data, ttls };
}
