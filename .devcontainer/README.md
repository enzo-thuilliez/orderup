# Dev container

One environment for you, CI-like checks and coding agents: open the repo in VS Code
("Reopen in Container") or GitHub Codespaces. `post-create.sh` installs uv, pre-commit,
gitleaks and Claude Code, then the project dependencies.

Behind a corporate proxy:

- `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` are passed through from the host when set.
- A company CA bundle is not configured by default (an empty CA variable breaks TLS). Add it
  locally in `devcontainer.json`: a `mounts` entry for the bundle, and `containerEnv` with
  `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS` pointing at the mounted path.

Never commit a certificate or proxy credentials.
