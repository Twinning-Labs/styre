import { loadProfileByConvention, slugForCwd } from "../config/discover.ts";
import type { Profile } from "../dispatch/profile.ts";
import { loadProfile } from "../dispatch/profile.ts";
import { type NonPrimaryComponent, partitionByRole } from "./component-roles.ts";
import { usageError } from "./errors.ts";

/** A profile as this RUN will use it: already narrowed to the components that take part. */
export interface LoadedProfile {
  profile: Profile;
  /** What role classification removed, so the run can report it. Never silently dropped. */
  nonPrimary: NonPrimaryComponent[];
  slug: string;
}

/**
 * Load a profile ALREADY NARROWED by component role (ENG-435).
 *
 * WHY LOADING AND NARROWING ARE ONE STEP. ENG-425 added the role gate as a statement partway
 * down `runImpl`, which left an un-narrowed profile in scope above it for anything to read — and
 * three things did: `assertResolved`, `assertInPlaceIdentity` (which killed
 * sphinx-doc__sphinx-7590 on a component it had itself classified `fixture`), and `resumeRun`,
 * which took the whole profile and RETURNED, bypassing the gate entirely on every resumed run.
 *
 * The first fix moved the statement higher and added an invariant asserting it preceded a list of
 * named consumers. An independent review broke that in two lines: inserting a new consumer above
 * the gate passed, and re-introducing the original bug as `assertResolved({ ...profile })` — one
 * character of spelling difference — passed too. A guard that enumerates call sites cannot see
 * the call site nobody thought to enumerate; that is the same shape as the defect it was written
 * to prevent.
 *
 * So there is no ordering left to guard: an un-narrowed profile is never bound to a name in
 * `run.ts`. The narrowing is a property of LOADING rather than a step in one code path, which is
 * what makes it hold on the resume path as well.
 *
 * NOT FATAL HERE, deliberately. Refusing a run with nothing primary left is the caller's
 * decision, because `--resume`/`--inspect` must not gain a new way to exit 69:
 * `docs/architecture/runtime-parameters.md` states that exit 69 is "never raised on
 * `--resume`/`--inspect`", and `--inspect` is a read-only diagnostic that exits 0.
 */
export function loadRunProfile(args: { profile?: string; slug?: string }): LoadedProfile {
  let raw: Profile;
  let slug: string;
  if (args.profile && args.profile.length > 0) {
    raw = loadProfile(args.profile);
    slug = args.slug && args.slug.length > 0 ? args.slug : raw.slug;
  } else {
    const derived = args.slug && args.slug.length > 0 ? args.slug : slugForCwd();
    if (!derived) {
      throw usageError(
        "no --profile given and the current directory is not a git repo",
        "cd into the target repo, or pass --profile / --slug.",
      );
    }
    slug = derived;
    raw = loadProfileByConvention(derived);
  }
  const { primary, nonPrimary } = partitionByRole(raw);
  // ALWAYS a new object, even when nothing was dropped. Returning `raw` itself in that branch
  // would make the profile's identity depend on repo content, so a later `profile.targetRepo =`
  // would mutate the caller's loaded object on some repos and a copy on others.
  return { profile: { ...raw, components: primary }, nonPrimary, slug };
}
