export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Warn (not fail) on unknown scopes so new areas don't block a commit.
    'scope-enum': [1, 'always', ['shared', 'server', 'cli', 'web', 'docs', 'ci', 'deps', 'repo']],
  },
};
