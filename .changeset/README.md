# Changesets

Only `orderup-cli` is published; the other workspaces are private and never versioned here.

When a PR changes what users of `orderup-cli` get, add a changeset:

```sh
npx changeset   # pick orderup-cli, a bump type, and a one-line summary
```

Releases are described in [docs/releasing.md](../docs/releasing.md).
