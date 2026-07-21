# worktree

Go CLI for managing git worktrees. See `docs/design-proposal.md` for architecture.

## Build & Test

```bash
make build    # builds to bin/worktree
make test     # runs go test ./...
make install  # installs to /usr/local/bin + runs setup
make clean    # removes bin/
```

## Project Structure

- `cmd/` — cobra commands (one file per subcommand)
- `internal/` — packages (config, discovery, gitutil, github, jira, ports, resources, env, dotfiles, setup, ui)
- `docs/` — design documents and feature catalog
