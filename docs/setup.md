# Setup guide

← [Back to the README](../README.md) · [CLI reference](cli.md) · [Configuration](configuration.md)

`worktree setup` is an interactive wizard. `make install` runs it for you, and you can run it again whenever you like: it shows what's already configured and only asks about what's missing or broken. `worktree setup --yes` runs it without asking, accepting every default.

## What setup does

1. **Directories.** Asks where worktrees should go (default `~/.worktrees`), and writes `~/.config/worktree/config.yaml`.
2. **Database.** Creates the SQLite database at `${XDG_DATA_HOME:-~/.local/share}/worktree/worktree.db`. Set `WORKTREE_DB` to put it somewhere else.
3. **Shell hook.** Adds a hook to your `.zshrc`, `.bashrc` or fish config that runs `eval "$(worktree env)"` each time you change directory, so `WORKTREE_PORTS` and `KUBECONFIG` follow you into each worktree.
4. **Completions.** Installs shell completions for `worktree` and `wt` (zsh, bash, fish).
5. **Services.** Asks whether to turn on GitHub, Jira and Slack. A service that's off is never contacted, and setup skips its credentials.
6. **Credentials.** Tests the credentials for each service that's on, and walks you through replacing any that are missing or rejected (see below).
7. **Jira projects.** Optionally records your Jira project keys, which are used to spot issue keys in branch names and PR titles.
8. **Web UI.** Generates the UI password, and optionally sets up access from other devices (see below).
9. **Menu bar app.** On macOS, offers to install the [menu bar app](#macos-menu-bar-app).

An interactive run ends with getting-started tips, which `worktree --help` also shows.

Setup re-tests your credentials on every run, so running it again is the quickest way to catch and fix an expired token.

## Connecting services

All credentials are stored in the watcher library's shared file, `~/.config/watcher/auth.yaml` (mode `0600`). They're not in worktree's own config.

### GitHub

You need a GitHub token. If the [GitHub CLI](https://cli.github.com/) is installed and logged in, setup offers to use its token (`gh auth token`) so you don't have to paste one. worktree itself never runs `gh`.

### Jira

You need your Jira site (e.g. `your-org.atlassian.net`), your email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens).

### Slack

Slack uses your own browser session: an `xoxc-` token and an `xoxd-` cookie, not an app token. Setup can capture these **automatically**. It opens a Chromium window (driven by Playwright), you log in to Slack as usual, and it reads the session from there. This needs `node`/`npx`, and downloads Chromium once into `~/.cache/worktree`. Without Node, setup walks you through copying the token and cookie by hand.

```bash
worktree setup slack          # Test the stored Slack session, capturing a new one if needed
worktree setup slack --force  # Always capture a new one
```

Slack sessions expire every week or two. When one does, run `worktree setup slack`.

> **Security note:** the token and cookie *are* your Slack login. Treat them like a password, and never commit them.

## Web UI password and remote access

`worktree ui` won't start without `ui.password`, on any address, even `127.0.0.1`. Setup generates the password and prints it. If you lose it, the login page tells you where to find it.

By default the UI only listens on `http://127.0.0.1:8475`. Setup can also enable **HTTPS access from your other devices**, such as your phone:

1. Setup offers this machine's `.local` name and its LAN IP as addresses.
2. It creates a certificate authority and signs a single certificate for those addresses. The CA's private key is never saved, so the CA can't sign anything else.
3. Install the CA certificate (`ui-ca.pem`, written next to your config) on each device and trust it. You still need the password to log in.
4. The UI then also serves `https://<name>:8476` (`ui.https_port`) on every interface.

If your addresses change, or the certificate expires, run setup again and reinstall the new CA on your devices. `worktree ui` warns you when the certificate no longer covers this machine's addresses. Use **Settings → Devices** to log out a single browser, or `worktree ui --revoke-all-sessions` to log out all of them.

## macOS menu bar app

On macOS with `swiftc` installed (Xcode Command Line Tools), an interactive `worktree setup` offers to install `~/Applications/Worktree Menu Bar.app`. Clicking its icon shows the web UI's Activity and Tasks views in a dropdown. That's the `/mini` page of `worktree ui`, which must be running.

- **Building.** The app is compiled locally from source embedded in worktree. The first build takes about 16 seconds, and later ones about 3. Setup rebuilds the app only when that source has changed, and restarts it if it was running.
- **Interactive only.** `worktree setup --yes` never installs the app. Run `worktree setup` interactively once.
- **Logging in.** The dropdown is its own browser, so it shows the login page once and then keeps its session.
- **Start at login.** Answering yes to "Start it at login?" writes `~/Library/LaunchAgents/me.turley.worktree.menubar.plist`. After that, the right-click menu's "Open at login" item turns it on and off.
- **Right-click menu.** Open full UI, Reload, Reset dropdown to default size, Open at login, Use purple wt icon, Flash icon for unread activity, More settings in web UI, and Quit.
- **Removing it.** `worktree setup --uninstall-mac-app` removes only the app, its login item and its web view data.

## Uninstalling

`worktree setup --uninstall` removes the shell hook, the completions and the menu bar app. It keeps `~/.config/worktree/config.yaml`, because that holds your settings, and tells you how to delete it yourself.
