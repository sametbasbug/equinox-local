## What changed

<!-- Describe the user-visible or architectural change. -->

## Why

<!-- What problem does this solve? -->

## Security boundaries

- [ ] I did not add a generic shell/command execution surface.
- [ ] Project and file access remains explicit and path-contained.
- [ ] Credentials, runtime keys, private paths and sensitive machine details are not exposed.
- [ ] Equinox Browser remains the only product browser-automation lane.
- [ ] Equinox Local updates do not sideload or overwrite the Chrome extension.

## Validation

- [ ] `npm run check`
- [ ] `npm test`
- [ ] Relevant new/changed behavior has tests

## Notes

<!-- Screenshots, migration notes, follow-up work, or anything reviewers should know. -->
