# Claude Code Guidelines

## Running the Server

Start the server with:

```bash
./start.sh
```

This script is used instead of running `npm start` directly because it:
- Validates that the required tmux session exists before starting
- Checks if Claude Code is running in the tmux session
- Provides helpful setup instructions if the session is missing
- Ensures the working directory is correct before starting the server

## Commit Messages

- Never use emojis in commit messages
- Never add Co-Authored-By or any attribution to Claude in commits
- Keep commit messages clean and concise
- Focus on what changed and why, not who made the change

## Code Style

- Never use emojis in code, comments, or documentation
- Keep code clean and minimal
