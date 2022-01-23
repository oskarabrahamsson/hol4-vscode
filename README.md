# HOL4 mode for Visual Studio Code

Support for working with the [HOL4 interactive theorem prover](https://hol-theorem-prover.org) in
Visual Studio Code. Adds functionality to maintain a HOL session in an editor window, basic
syntax highlighting, and basic unicode input completion.

## Requirements

Expects a HOL4 installation to exist, and the environment variable `$HOLDIR` to point to this
installation. The HOL4 homepage can be found [here](https://hol-theorem-prover.org) and its GitHub
repository [here](https://github.com/HOL-Theorem-Prover/HOL).

## Extension Settings

N/A

## Known Issues

- Syntax highlighting is lacking. Logical terms are expecially bad. The situation
  could be improved by implementing a HOL language server.
- There is some hacky code that attempts to strip ML comments from input that is
  being sent to HOL. Currently, this does not properly deal with nested comments,
  or comment tokens that exist within string literals.
- `load` calls are not inserted when calls to qualified ML code is made.
- It's possible to find calls to `{Co}Inductive`, `Datatype`, `Theorem` etc. and
  insert location pragmas.