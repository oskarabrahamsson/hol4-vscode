# HOL4 mode for Visual Studio Code

Support for working with the [HOL4 interactive theorem prover](https://hol-theorem-prover.org) in
Visual Studio Code. Adds functionality to maintain a HOL session in an editor window, basic
syntax highlighting, and basic unicode input completion.

## Requirements

Expects a HOL4 installation to exist, and the environment variable `$HOLDIR` to point to this
installation. The HOL4 homepage can be found [here](https://hol-theorem-prover.org) and its GitHub
repository [here](https://github.com/HOL-Theorem-Prover/HOL).

## Extension Settings

Suggested additions to `settings.json` for use with [VSCodeVim](https://github.com/VSCodeVim/Vim),
somewhat corresponding to the HOL4 Vim mode defaults:
```json
{
    "vim.visualModeKeyBindings": [
      {
        "before": [ "<leader>", "e" ],
        "commands": [ "hol4-mode.sendTactic" ]
      },
      {
        "before": [ "<leader>", "s" ],
        "commands": [ "hol4-mode.sendSelection" ]
      },
    ],
    "vim.normalModeKeyBindings": [
      {
        "before": [ "<leader>", "h" ],
        "commands": [ "hol4-mode.startSession" ]
      },
      {
        "before": [ "<leader>", "<leader>", "x" ],
        "commands": [ "hol4-mode.stopSession" ]
      },
      {
        "before": [ "<leader>", "s" ],
        "commands": [ "hol4-mode.sendSelection" ]
      },
      {
        "before": [ "<leader>", "<leader>", "s" ],
        "commands": [ "hol4-mode.sendUntilCursor" ]
      },
      {
        "before": [ "<leader>", "g" ],
        "commands": [ "hol4-mode.sendGoal" ]
      },
      {
        "before": [ "<leader>", "S" ],
        "commands": [ "hol4-mode.sendSubgoal" ]
      },
      {
        "before": [ "<leader>", "e" ],
        "commands": [ "hol4-mode.sendTactic" ]
      },
      {
        "before": [ "<leader>", "p" ],
        "commands": [ "hol4-mode.proofmanShow" ]
      },
      {
        "before": [ "<leader>", "b" ],
        "commands": [ "hol4-mode.proofmanBack" ]
      },
      {
        "before": [ "<leader>", "R" ],
        "commands": [ "hol4-mode.proofmanRestart" ]
      },
      {
        "before": [ "<leader>", "r" ],
        "commands": [ "hol4-mode.proofmanRotate" ]
      },
      {
        "before": [ "<leader>", "d" ],
        "commands": [ "hol4-mode.proofmanDrop" ]
      },
      {
        "before": [ "<leader>", "y" ],
        "commands": [ "hol4-mode.toggleShowTypes" ]
      },
      {
        "before": [ "<leader>", "a" ],
        "commands": [ "hol4-mode.toggleShowAssums" ]
      },
      {
        "before": [ "<leader>", "c" ],
        "commands": [ "hol4-mode.interrupt" ]
      }
    ]
}
```

## Known Issues

- Syntax highlighting is lacking. Logical terms are especially bad. The situation
  could be improved by implementing a HOL language server.
- There is some hacky code that attempts to strip ML comments from input that is
  being sent to HOL. Currently, this does not properly deal with nested comments,
  or comment tokens that exist within string literals.
- Comments are not stripped from tactic text.
- `load` calls are not inserted when calls to qualified ML code is made.
- Location pragmas are not inserted at calls to `{Co}Inductive`, `Datatype`,
  `Theorem`, nor in term quotations.
