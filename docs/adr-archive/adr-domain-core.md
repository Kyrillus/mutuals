# DECISION: `packages/core` — the domain layer

**Status:** Proposed (Stage 0). Load-bearing for `apps/api`, `apps/web`, `packages/db`, the importer, the
LLM layer and the future MCP server.
**Consistent with:** `storage-DECISION.md` (typed EAV projection over an append-only fact log). Where
this document *changes* something in that decision, it says so in bold and the change is listed in
§12 (one item, §2.4).
**Verified library versions** (checked against the npm registry on 2026-09-03, see §11):
`zod@4.5.4`, `libphonenumber-js@1.13.12`, `vitest@4.1.11`, `typescript@7.0.2`.

---

## 0. The decision in one paragraph

`packages/core` is a **pure, clock-free, I/O-free, SQL-emitting** package with exactly two runtime
dependencies (`zod`, and `libphonenumber-js` behind its own subpath export). Everything the product
knows about *what an attribute is* lives in a **data-driven type registry**: twelve files, one per
attribute type, each exporting a single frozen object that carries the type's Zod value schema, its
config schema, its normalisation function, its `value_key` derivation, its allowed filter operators
and its sort semantics. The names of the physical value columns (`text_value`, `num_value`, …) appear
in **exactly one file** (`attributes/slots.ts`) and a CI grep test fails the build if they appear
anywhere else. The filter model is a discriminated union on the **operator**, so an operator's arity
is enforced by the type system, while the *interpretation* of its string payload is decided by the
resolved field — which means the wire format is uniformly strings and the query-string codec is
lossless. Everything is a total function returning `Result<T>`; nothing throws on user input; nothing
reads `Date.now()`. That last rule is not fussiness: relative filters ("no interaction in 90 days")
must be stored **as relative** in a saved view and resolved at compile time against an injected
`today`, or every saved view silently freezes on the day it was created.

---

## 1. Ground rules

### 1.1 Purity, and why `now` is a parameter

Three properties, in priority order:

1. **No I/O.** No `fs`, no `pg`, no `fetch`. Core computes; callers persist. This is what makes the
   brief's §8.1 "unit tests, high coverage — these are the parts that break silently" actually cheap:
   the whole package is testable with `vitest run` and no container, no database, no fixtures beyond
   plain data.
2. **No ambient clock, no ambient timezone, no ambient locale.** Every function that needs the current
   time takes it as an argument. `computeWarmth({ …, asOf })`, `compileRowsQuery({ …, today })`,
   `nextOccurrence(rule, { dueAt, completedAt, today })`.
   - *Test consequence:* every date test is exact, not "within a day".
   - *Product consequence:* the filter `last_interaction_at older_than 90 days` is stored in the saved
     view as `older_than:90`, **not** as a resolved date, and the compiler turns it into
     `now() - interval` at query build time. A saved view called "No interaction in 90 days" keeps
     meaning that next year. If core read the clock internally, the temptation to resolve at *save*
     time would be one refactor away.
   - *Rejected alternative:* an injected `Clock` interface. It is the same thing with a wrapper object,
     and it invites `clock.now()` to be called three times inside one computation with three different
     answers. A single `asOf` value passed down is strictly more deterministic.
3. **No exceptions for user input.** Every parse/validate/coerce returns

   ```ts
   export type Result<T, E = readonly CoreIssue[]> =
     | { readonly ok: true;  readonly value: T }
     | { readonly ok: false; readonly issues: E };

   export interface CoreIssue {
     readonly code: IssueCode;          // closed union, see below
     readonly path: readonly (string | number)[];  // ['values', 2] — maps to a cell / a form field
     readonly message: string;          // English, user-facing, no jargon
     readonly meta?: Readonly<Record<string, string | number | boolean>>;
   }
   ```

   Programmer errors (an unknown attribute type reaching the registry) *do* throw — they are bugs, not
   input. The line is: **anything that can arrive from a CSV, a form, a URL or an LLM returns
   `Result`.** A 10 000-row import that throws on row 4 000 is both slow (V8 deoptimises throw-heavy
   loops) and useless (§6.8 needs *all* the bad rows highlighted at once, not the first one).

`IssueCode` is a closed string union (`'required' | 'invalid_email' | 'invalid_phone' |
'unknown_option' | 'bad_date' | 'ambiguous_date' | 'too_long' | 'out_of_range' | 'not_a_number' |
'reserved_slug' | 'duplicate_slug' | 'unknown_field' | 'operator_not_allowed' | 'not_sortable' |
'arity_mismatch' | …`). It is closed because the API maps codes to HTTP-level field errors (§7 of the
brief: "validation errors per field") and the import wizard's `Find errors` filter (§6.8) is a
`groupBy(code)`.

### 1.2 Dependency budget

| Dependency | Version | Why it is allowed |
|---|---|---|
| `zod` | **4.5.4** | The brief mandates Zod value schemas per attribute type. Zod 4 also gives us `z.toJSONSchema()` for free, which is how the same schema serves OpenAPI (§7) *and* the LLM's structured-output contract (§4.8) without a third representation. |
| `libphonenumber-js` | **1.13.12** | E.164 normalisation with correct per-country trunk-prefix handling. Exposed through the subpath `@mutuals/core/phone`, so a browser bundle that only needs the filter model never pulls the ~145 kB metadata. |

**Everything else is hand-written**, each with a rejected alternative:

- **Slugs:** ~40 lines, not `@sindresorhus/slugify`. We need reserved-word checking, a 63-character
  Postgres-identifier cap and deterministic de-duplication anyway; the transliteration part is the
  smallest half.
- **Dates:** a `CivilDate = 'YYYY-MM-DD'` string module (~90 lines), not `date-fns`, not `Temporal`.
  **Verified:** Node 24.20.0 (this project's pinned runtime) has no global `Temporal` — it is behind
  `--harmony-temporal`; `Temporal` is on by default only from Node 26. A polyfill would be a
  throwaway. `date-fns` would need its month-clamping behaviour pinned by our own tests regardless,
  which is most of the work.
- **Recurrence:** a closed five-variant union, not `rrule@2.8.1`. The brief's set is
  weekly / monthly / every N months / yearly / every N days — five cases. RRULE brings BYSETPOS,
  BYDAY, COUNT, UNTIL, EXDATE, timezone handling and a `Date`-based API for a feature whose entire
  UI is a six-item dropdown. "Prefer boring technology" cuts both ways: a 200-line closed union that
  we fully understand beats a correct-but-vast standard we use 3 % of. **Extension point:** the
  persisted shape is a tagged object, so an `{ kind: 'rrule', rrule: string }` variant can be added
  later without touching the stored rows.
- **Public-suffix parsing:** none. See §7.4 — website identity is host-based and deliberately does not
  need a PSL.
- **String similarity:** hand-written trigram similarity that reproduces `pg_trgm`'s definition
  (§7.5), not `string-similarity` / `fastest-levenshtein`. The point is *agreement with the database*,
  which no off-the-shelf library provides.

### 1.3 TypeScript 7 constraints

**Verified:** TypeScript 7.0 (released 2026-07-08) is a Go port of the compiler that preserves
type-checking semantics; the removals are in JS/JSDoc inference (`@enum`, `@constructor` tags), not in
the type system. Nothing in this design depends on anything TS 7 dropped.

We nonetheless compile core with `erasableSyntaxOnly: true`, `verbatimModuleSyntax: true`,
`exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`. Consequences that shape the code
below: **no `enum`, no `namespace`, no parameter properties** — every closed set is
`const X = [...] as const` plus `type X = (typeof X)[number]`. This is also what makes the registry's
exhaustiveness checks work (`satisfies Record<AttributeType, …>`), so it is not merely stylistic.

### 1.4 Package layout and export map

```
packages/core/
  package.json          # "exports": { ".": …, "./phone": …, "./sql": … }
  src/
    result.ts               Result, CoreIssue, IssueCode, assertNever
    text/normalize.ts       ← THE definition of text normalisation (§2.4)
    text/trigram.ts         pg_trgm-compatible trigrams + similarity
    text/names.ts           person/org name keys, honorifics, legal suffixes
    time/civil.ts           CivilDate arithmetic, todayIn(tz, now)
    decimal.ts              decimal-string parse/compare/round
    attributes/slots.ts     ← THE ONLY file containing physical column names
    attributes/kinds.ts     ValueKind, SlotValue
    attributes/types/       short-text.ts long-text.ts number.ts date.ts yes-no.ts
                            single-select.ts multi-select.ts tags.ts url.ts email.ts
                            phone.ts relation.ts
    attributes/registry.ts  barrel, lookup, exhaustiveness
    attributes/slug.ts      suggestSlug, validateSlug
    attributes/reserved.ts  three-tier reserved list
    fields/system.ts        system + derived pseudo-fields per object type
    fields/resolve.ts       FieldResolver, FieldSource
    filters/model.ts        the discriminated union + Zod schemas
    filters/operators.ts    OperatorId, arity, per-type allowance
    filters/serialize.ts    query-string codec
    filters/relative.ts     relative presets → absolute ranges
    filters/compile.ts      → Postgres SQL text + params
    sort/compile.ts
    warmth.ts
    identity/email.ts | phone.ts | linkedin.ts | website.ts | index.ts
    identity/duplicates.ts
    followups/recurrence.ts followups/state.ts
    import/synonyms.ts | presets/{generic,linkedin,google-contacts,vcard}.ts
    import/automap.ts | value-mapping.ts | validate.ts | date-format.ts
    index.ts
```

`./phone` is a separate entry point so `apps/web` can import the registry and the filter model without
the phone metadata. `./sql` is separate so a future non-Postgres consumer (there is none planned) can
take the domain without the compiler — and, more usefully today, so the browser bundle provably does
not contain SQL strings.

**File-format parsers (CSV, XLSX, vCard) are NOT in core.** They are streaming, dependency-hungry and
I/O-shaped. Core owns the *decisions* (which column maps to which field, is this value valid, is this
row a duplicate); `packages/import` owns the bytes and hands core a `RawRow = Record<string, string>`.
The line is worth stating because vCard parsing in particular looks pure and would drag quoted-printable
decoding and line-unfolding into the domain package.

---

## 2. Shared primitives

### 2.1 `SlotValue` — the canonical value shape

There is exactly one in-memory representation of "a value that has been normalised and is ready to be
written as a fact", and it is a tagged union whose tags are the database's `value_kind` enum:

```ts
// attributes/kinds.ts
export const VALUE_KINDS = ['text', 'number', 'date', 'bool', 'option', 'relation'] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

export type SlotValue =
  | { readonly kind: 'text';     readonly text: string;  readonly norm: string; readonly sort: string | null }
  | { readonly kind: 'number';   readonly num: DecimalString }
  | { readonly kind: 'date';     readonly date: CivilDate }
  | { readonly kind: 'bool';     readonly bool: boolean }
  | { readonly kind: 'option';   readonly optionId: Uuid; readonly optionKey: string }
  | { readonly kind: 'relation'; readonly targetRecordId: Uuid; readonly link?: LinkMetadata };

export interface LinkMetadata {                    // §4.3
  readonly title?: string;
  readonly from?: CivilDate;
  readonly to?: CivilDate | null;                  // null = current
  readonly isPrimary?: boolean;
}
```

The `text` variant carries `norm` and `sort` because **core owns text normalisation** (§2.4) and the
write path ships all three columns to the database.

### 2.2 Numbers are decimal strings

`DecimalString = string` (branded), validated by `/^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,10})?$/`.

The brief's §4.2 table says `number` is *stored as* **decimal**, and the storage decision uses PG
`numeric`. A JS `number` cannot round-trip `numeric` — not for large integers (crypto amounts, company
valuations) and not for exact decimal arithmetic. Making the canonical form a string means the value
the user typed is the value stored is the value returned, byte for byte.

- **Rejected:** `number` (double). Simpler everywhere, and wrong in exactly the cases a CRM tracking
  cheque sizes and valuations will eventually hit; the failure is silent (a `1_000_000_000_000_000_001`
  becomes `…000`).
- **Rejected:** a `Decimal` class (decimal.js / big.js). A third dependency for what we actually need,
  which is: validate, compare, round to `config.decimals`, format. That is ~50 lines (`compareDecimal`
  aligns exponents and compares digit strings; no arithmetic beyond that is required — core never
  *adds* two user numbers).

`decimal.ts` exports `parseDecimal(raw, { decimals, min, max }): Result<DecimalString>`,
`compareDecimal(a, b): -1 | 0 | 1`, `formatDecimal(d, { decimals, unit, locale }): string`.

### 2.3 Dates are civil dates

`CivilDate = string` (branded), `'YYYY-MM-DD'`, proleptic Gregorian, no time, no zone. `time/civil.ts`:

```ts
export function parseCivil(raw: string): Result<CivilDate>;
export function addDays(d: CivilDate, n: number): CivilDate;
/** Adds n months, clamping to the month's last day, anchored on `anchorDay` (1–31). */
export function addMonths(d: CivilDate, n: number, anchorDay?: number): CivilDate;
export function diffDays(a: CivilDate, b: CivilDate): number;     // a - b, whole days
export function compareCivil(a: CivilDate, b: CivilDate): -1 | 0 | 1;
export function dayOfMonth(d: CivilDate): number;
/** The civil date "now" is in the given IANA zone. Uses Intl only — no dependency. */
export function todayIn(timeZone: string, now: Date): CivilDate;
```

`todayIn` is implemented with `Intl.DateTimeFormat(…, { timeZone }).formatToParts` and assembled from
the `year`/`month`/`day` parts (not `en-CA` string formatting, which is a locale coincidence rather
than a guarantee). Node 24 ships full ICU by default, so no `full-icu` dance.

Timestamps (`occurred_at`, `created_at`, `last_interaction_at`) stay as `Date`/ISO strings — they are
genuinely instants. Only *date-typed attributes* and follow-up due dates are civil.

### 2.4 Text normalisation — **the one change to the storage decision**

Every text value has three forms, and the same three forms are used on the write path, the read path
and the filter path:

| Form | Definition | Used for |
|---|---|---|
| `text_value` | the user's input, `btrim`-ed only | display, CSV export, round-trip |
| `text_norm` | `fold(lower(trim(v)))`, full length | `contains` (trigram GIN), `equals` recheck, tag identity |
| `text_sort` | first 256 **code points** of `text_norm`; `null` for `long_text` | `ORDER BY` and the indexed prefix of `equals` |

```ts
// text/normalize.ts — the source of truth for the entire product
const EXPANSIONS: readonly (readonly [string, string])[] = [
  ['ß', 'ss'], ['æ', 'ae'], ['œ', 'oe'], ['ø', 'o'],  ['å', 'a'],
  ['đ', 'd'],  ['ð', 'd'],  ['þ', 'th'], ['ł', 'l'],  ['ħ', 'h'],
  ['ı', 'i'],  ['ŋ', 'n'],  ['ŧ', 't'],  ['ƀ', 'b'],  ['µ', 'u'],
];

/** Lower-case + accent-fold + ligature-expand. Total, idempotent, locale-independent. */
export function foldText(input: string): string {
  let s = input.toLowerCase();
  for (const [from, to] of EXPANSIONS) s = s.replaceAll(from, to);
  return s.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
}

export function normalizeText(input: string): string {
  return foldText(input).replace(/\s+/gu, ' ').trim();
}

/** Sort key: code-point-safe truncation, never splits a surrogate pair. */
export function sortKey(norm: string, isLongText: boolean): string | null {
  if (isLongText) return null;
  const cps = [...norm];
  return cps.length <= 256 ? norm : cps.slice(0, 256).join('');
}

/** Identity of one value inside a multi-valued attribute (tags). */
export function valueKey(norm: string): string {
  const cps = [...norm];
  return cps.length <= 512 ? norm : cps.slice(0, 512).join('');
}
```

**The change.** `storage-DECISION.md` §2.5 has the *SQL projector* compute
`lower(unaccent(btrim(f.text_value)))`, while §5.3 has the *filter needle* normalised in
`packages/core`. Those two are not the same function, and the divergence is silent:

| input | PG `unaccent` (CLDR Latin-ASCII rules, **verified**: default rules include ligature expansion, "Æ to AE") | naive JS NFD-strip |
|---|---|---|
| `Straßburg` | `strassburg` | `straßburg` |
| `Ærø` | `aero` | `æro` |
| `Łódź` | `lodz` | `łodz` |

A German user filtering `city contains "Straßburg"` would get **zero rows** while the row is right
there. For this project's two German users, that is a bug on day one.

**Resolution: normalisation happens only in TypeScript. `fact` gains `text_norm` and `text_sort`
columns; the projector copies them instead of computing them; the `unaccent` extension is dropped.**

- Options considered:
  1. *Status quo* — PG `unaccent()` on write, JS fold on query. **Rejected:** silent wrong answers on
     ß/æ/ø/ł, i.e. on German, Scandinavian and Polish names, in an address book.
  2. *Generate an `IMMUTABLE mutuals_norm(text)` SQL function from the same fold table*
     (`lower` → `replace` chain → `normalize(…, NFD)` → `regexp_replace('[̀-ͯ…]','','g')`).
     One source, two emissions, plus a CI test comparing them over a corpus. Works, and has the bonus
     that it is `IMMUTABLE` where `unaccent()` is only `STABLE`. **Rejected:** PG's regex engine has no
     `\p{M}` class, so the combining-mark ranges must be enumerated by hand and will drift from JS's
     `\p{M}` for non-Latin scripts; and it is more machinery than option 3.
  3. **Chosen:** one implementation, in core; `fact.text_norm` / `fact.text_sort` are written by the
     application; `attribute_value` gets them by column copy. `db:reproject` still rebuilds everything
     from `fact` alone. A hand-written `INSERT INTO fact` from `psql` that omits `text_norm` now fails
     a `CHECK` **loudly** instead of producing a row that is invisible to filters.
- Cost: `fact` grows by roughly the size of one extra copy of each text value (~+25 % on text facts,
  ~+8 MB at the 10 k-contact sizing in the storage decision's §9.1). Accepted.
- Benefit beyond correctness: `unaccent` disappears from the required-extension list, which removes
  the storage decision's §2.5 "fallback if `unaccent` is unavailable" branch entirely and makes the
  schema portable to any Postgres 16 with `pg_trgm` + `btree_gin` + `vector`.

**Accepted limitation, written down:** `foldText` folds Latin diacritics and the fifteen listed
expansions. It does not transliterate Greek, Cyrillic or CJK (`Мюнхен` stays `мюнхен`). Substring and
equality search still work within a script; only cross-script search does not, and nobody asked for it.

---

## 3. The attribute-type registry

### 3.1 The one file that knows column names

```ts
// attributes/slots.ts — the ONLY place these strings exist outside packages/db's schema.
export const SLOT_COLUMNS = {
  text:     { value: 'text_value', norm: 'text_norm', sort: 'text_sort' },
  number:   { value: 'num_value',  sort: 'num_value'  },
  date:     { value: 'date_value', sort: 'date_value' },
  bool:     { value: 'bool_value', sort: 'bool_value' },
  option:   { value: 'option_id'   },
  relation: { value: 'target_record_id' },
} as const satisfies Record<ValueKind, { value: string; norm?: string; sort?: string }>;

export type SlotColumn =
  | typeof SLOT_COLUMNS[ValueKind]['value']
  | 'text_norm' | 'text_sort' | 'value_key';

export const ALL_SLOT_COLUMNS: readonly SlotColumn[] = Object.freeze([
  'text_value', 'text_norm', 'text_sort', 'num_value',
  'date_value', 'bool_value', 'option_id', 'target_record_id', 'value_key',
]);
```

**Enforcement, not exhortation.** `CLAUDE.md` will say "never hard-code a column". A comment is not a
mechanism. The mechanism is a test:

```ts
// tests/architecture/no-hardcoded-columns.test.ts
const ALLOWED = ['packages/core/src/attributes/slots.ts', 'packages/db/src/schema/'];
it('no file outside the slot registry mentions a physical value column', async () => {
  const hits = await grepRepo(/\b(text_value|text_norm|text_sort|num_value|date_value|bool_value|option_id|target_record_id)\b/);
  expect(hits.filter(h => !ALLOWED.some(a => h.file.startsWith(a)))).toEqual([]);
});
```

Every emitted SQL fragment gets its column name from `SLOT_COLUMNS[def.valueKind]`, so a new value kind
is a new entry there and nowhere else.

### 3.2 The type-definition interface

```ts
// attributes/types/def.ts
export interface TypeContext {
  /** Options for this attribute, ordered by position. Empty for non-select types. */
  readonly options: readonly AttributeOption[];
  /** Default region for national-format phone numbers, from Profile. */
  readonly phoneRegion?: CountryCode;
}

export interface AttributeTypeDefinition<TConfig = unknown, TInput = unknown> {
  /** Machine name; also the discriminator in the DB `attribute_type` enum. */
  readonly type: string;
  readonly valueKind: ValueKind;
  readonly cardinality: 'single' | 'multi' | 'from-config';

  /** §6.7's create-attribute dialog is generated from this. */
  readonly configSchema: z.ZodType<TConfig>;

  /** The value schema for ONE concrete attribute definition. Used by the API, the form and the importer. */
  value(config: TConfig, ctx: TypeContext): z.ZodType<TInput>;

  /** Canonical DB form. Called only with a value that already passed `value()`. */
  normalize(input: TInput, config: TConfig, ctx: TypeContext): SlotValue;

  /** Free text (CSV cell, inline edit, LLM output) → TInput. Returns issues, never throws. */
  coerce(raw: string, config: TConfig, ctx: TypeContext): Result<TInput>;

  /** Display string for chips, CSV export and the LLM's context. */
  format(v: SlotValue, config: TConfig, ctx: TypeContext): string;

  /** Filter operators §4.2 allows for this type. Order = order in the operator dropdown. */
  readonly operators: readonly OperatorId[];

  /** null = the brief's "—": header not clickable, API returns 400 on sort. */
  readonly sort: SortSpec | null;

  /** §4.6 write-through. 'by-slug' = only when the slug is linkedin_url / website. */
  readonly identifier?: IdentifierKind | 'by-slug';

  /** Value-mapping UI in the import wizard (§6.8 step 3) applies to these. */
  readonly hasValueMapping: boolean;
}

export type SortSpec =
  | { readonly via: 'slot';   readonly column: SlotColumn; readonly invert?: boolean }
  | { readonly via: 'option-position' };
```

`invert` exists for exactly one type: `yes_no`, whose brief-specified sort is "yes first". With
`{ via: 'slot', column: 'bool_value', invert: true }` an ascending click emits
`bool_value DESC NULLS LAST` — the UI arrow and the data agree, and no other type needs a special case.

### 3.3 Three real type files

```ts
// attributes/types/short-text.ts
const config = z.object({ maxLength: z.int().min(1).max(255).optional() });

export const shortText = {
  type: 'short_text',
  valueKind: 'text',
  cardinality: 'single',
  configSchema: config,
  value: (c) => z.string().trim().min(1).max(c.maxLength ?? 255),
  normalize: (v) => {
    const norm = normalizeText(v);
    return { kind: 'text', text: v.trim(), norm, sort: sortKey(norm, false) };
  },
  coerce: (raw, c) => {
    const t = raw.trim();
    if (t === '') return err('required', [], 'This field is empty.');
    if ([...t].length > (c.maxLength ?? 255)) return err('too_long', [], `Longer than ${c.maxLength ?? 255} characters.`);
    return ok(t);
  },
  format: (v) => (v.kind === 'text' ? v.text : ''),
  operators: ['contains', 'equals', 'is_empty', 'is_not_empty'],
  sort: { via: 'slot', column: 'text_sort' },
  hasValueMapping: false,
} as const satisfies AttributeTypeDefinition<z.infer<typeof config>, string>;
```

```ts
// attributes/types/number.ts
const config = z.object({
  unit: z.string().max(16).optional(),
  decimals: z.int().min(0).max(10).default(0),
  min: decimalString.optional(),
  max: decimalString.optional(),
});

export const number = {
  type: 'number',
  valueKind: 'number',
  cardinality: 'single',
  configSchema: config,
  value: (c) => decimalString.refine(d => inRange(d, c.min, c.max), { error: 'Out of range.' }),
  normalize: (v, c) => ({ kind: 'number', num: roundDecimal(v, c.decimals) }),
  // Accepts "1.234,56" (de), "1,234.56" (en), "1 234,56", "€1.2k" is NOT accepted (ambiguous).
  coerce: (raw, c) => parseDecimalLoose(raw, c),
  format: (v, c) => formatDecimal(v.num, c),
  operators: ['eq', 'neq', 'lt', 'gt', 'between', 'is_empty', 'is_not_empty'],
  sort: { via: 'slot', column: 'num_value' },
  hasValueMapping: false,
} as const satisfies AttributeTypeDefinition<z.infer<typeof config>, DecimalString>;
```

```ts
// attributes/types/single-select.ts
// Options live in the `attribute_option` table, not in config — so config is empty and
// `ctx.options` carries them. This is why `value()` and `coerce()` take a TypeContext.
export const singleSelect = {
  type: 'single_select',
  valueKind: 'option',
  cardinality: 'single',
  configSchema: z.object({}),
  value: (_c, ctx) => z.enum(ctx.options.filter(o => !o.archivedAt).map(o => o.key) as [string, ...string[]]),
  normalize: (key, _c, ctx) => {
    const o = ctx.options.find(x => x.key === key)!;   // guaranteed by value()
    return { kind: 'option', optionId: o.id, optionKey: o.key };
  },
  coerce: (raw, _c, ctx) => matchOption(raw, ctx.options),   // exact key → exact label → folded label → trigram ≥ .8
  format: (v, _c, ctx) => ctx.options.find(o => o.id === v.optionId)?.label ?? '',
  operators: ['is_one_of', 'is_not_one_of', 'is_empty', 'is_not_empty'],
  sort: { via: 'option-position' },
  hasValueMapping: true,
} as const satisfies AttributeTypeDefinition<Record<never, never>, string>;
```

The other nine follow the same shape. `relation` is the only one whose `cardinality` is `'from-config'`
(`config.cardinality: 'one' | 'many'`), whose `sort` is `null`, and whose `normalize` produces the
`relation` slot with optional `LinkMetadata` — it is also the only type whose values never reach
`attribute_value` (they are projected into `record_link`), which the compiler handles by branching on
`valueKind === 'relation'` in exactly one place.

### 3.4 The registry, and what "adding a type is one file" really costs

```ts
// attributes/registry.ts
import { shortText } from './types/short-text.js';
/* … 11 more … */

const DEFINITIONS = [
  shortText, longText, number, date, yesNo, singleSelect,
  multiSelect, tags, url, email, phone, relation,
] as const;

export type AttributeType = (typeof DEFINITIONS)[number]['type'];
export const ATTRIBUTE_TYPES = DEFINITIONS.map(d => d.type) as readonly AttributeType[];

export const REGISTRY: Readonly<Record<AttributeType, AttributeTypeDefinition>> =
  Object.freeze(Object.fromEntries(DEFINITIONS.map(d => [d.type, d])) as never);

export function typeDef(t: AttributeType): AttributeTypeDefinition { return REGISTRY[t]; }
export function isMulti(def: AttributeDefinition): boolean {
  const t = typeDef(def.type);
  return t.cardinality === 'multi'
    || (t.cardinality === 'from-config' && (def.config as RelationConfig).cardinality === 'many');
}
export function isSortable(def: AttributeDefinition): boolean { return typeDef(def.type).sort !== null; }
```

Note the direction of the dependency: **`AttributeType` is derived from the registry**, not declared
separately. Adding a type is therefore:

1. one new file under `attributes/types/`;
2. one import + one array entry in `registry.ts`;
3. one `ALTER TYPE attribute_type ADD VALUE` migration (Postgres enums are DDL);
4. **plus** a `value_kind` migration *only if* the new type needs a physical slot no existing kind
   provides.

Claiming "one file" without steps 2–3 would be dishonest. A `rating` type (1–5 stars) reuses
`value_kind = 'number'` and is genuinely file + array entry + `ADD VALUE`. A `geo` type would need a
new slot column and a new `value_kind`.

**Rejected alternative — a class hierarchy** (`abstract class AttributeType` with `TextAttribute
extends …`). Inheritance would put shared behaviour in base classes and then need `instanceof` checks
at every call site; frozen plain objects give the same polymorphism, serialise to the API for free
(`GET /attribute-types` returns the registry so the frontend renders the create-attribute dialog and
the operator dropdowns from data, not from a duplicated frontend copy), and cannot carry hidden state.

**Rejected alternative — `switch (def.type)` at each call site.** It is what the brief explicitly
warns against ("never hard-code a column"): twelve switches drift, and the twelfth one forgets
`long_text`. With the registry, the compiler contains exactly two switches — over `valueKind` (six
cases, for the slot column) and over `OperatorId` (twenty-one cases, for the predicate) — both closed
by `assertNever`.

### 3.5 Unit tests that must exist — registry

| Test | Assertion |
|---|---|
| `registry.exhaustive` | `Object.keys(REGISTRY).sort()` equals the twelve type names; every entry's `type` equals its key |
| `registry.matches-brief-table` | table-driven over §4.2: for each of the 12 types, `operators` and `sort !== null` match the brief's table exactly (this test *is* the brief's table, transcribed once) |
| `registry.value-kind-consistency` | every `valueKind` is in `VALUE_KINDS`; every type whose `cardinality === 'multi'` is in `{tags, multi_select}` (mirrors the DB `ad_multi_matches_type` CHECK) |
| `registry.frozen` | `Object.isFrozen(REGISTRY)`; mutating a definition throws |
| `slots.single-source` | the architecture grep test in §3.1 |
| per type × 12 `value.accepts` / `value.rejects` | ≥ 4 valid and ≥ 4 invalid inputs each, incl. empty string, whitespace-only, 256-char text, `0`, `-0.00`, `1e9` as text |
| per type × 12 `normalize.idempotent` | `normalize(normalize(x))` is stable; `SlotValue.kind === valueKind` |
| per type × 12 `coerce.csv-shapes` | the messy real-world spellings each type must survive (see §9) |
| `format.round-trip` | for every type, `coerce(format(normalize(v)))` returns a value that normalises to the same `SlotValue` |
| `isMulti.relation-from-config` | `cardinality: 'many'` ⇒ multi; `'one'` ⇒ single |

The `registry.matches-brief-table` test deserves a note: it is the *only* place the brief's operator
table is written down a second time, and it exists so that a change to a type's operator list is a
deliberate two-file edit rather than an accident.

---

## 4. Slugs and reserved words

### 4.1 Signatures

```ts
// attributes/slug.ts
export type Slug = string & { readonly __brand: 'Slug' };

/** Deterministic suggestion from a title. Never throws; always returns a valid, unused slug. */
export function suggestSlug(title: string, taken: ReadonlySet<string>): Slug;

/** Validates a user-edited slug. The API calls this; the DB CHECK is the backstop. */
export function validateSlug(
  raw: string,
  ctx: { readonly objectType: ObjectType; readonly taken: ReadonlySet<string> },
): Result<Slug>;

export function isReservedSlug(slug: string, objectType: ObjectType): boolean;
```

### 4.2 The generation algorithm

`foldText` → replace every run of non-`[a-z0-9]` with `_` → collapse `__` → strip leading/trailing `_`
→ if empty or starting with a digit, prefix `f_` → truncate to 63 code points at an underscore
boundary where possible → if reserved or taken, append `_2`, `_3`, … (recomputing the truncation so the
result stays ≤ 63).

Why 63: `slug ~ '^[a-z][a-z0-9_]{0,62}$'` in the storage decision, which is the Postgres identifier
limit. Slugs never reach SQL as identifiers today — but the storage decision's §9.6 promotion path
(`city` becomes a real column on `contact`) turns a slug into an identifier, and a 64-character slug
would silently truncate into a collision at exactly the moment someone is optimising under pressure.

### 4.3 The reserved list — three tiers, one of them derived

```ts
// attributes/reserved.ts
/** Tier 1 — derived, so it can never drift from the field registry. */
const systemSlugs = (o: ObjectType) => new Set(SYSTEM_FIELDS[o].map(f => f.slug));

/** Tier 2 — SQL. Postgres 16 reserved + reserved(can-be-function-or-type) key words. */
export const SQL_KEYWORDS: readonly string[] = ['all','analyse','analyze','and','any','array','as','asc',
  'asymmetric','both','case','cast','check','collate','column','constraint','create','current_date',
  'current_role','current_time','current_timestamp','current_user','default','deferrable','desc','distinct',
  'do','else','end','except','false','fetch','for','foreign','from','grant','group','having','in','initially',
  'intersect','into','lateral','leading','limit','localtime','localtimestamp','not','null','offset','on','only',
  'or','order','placing','primary','references','returning','select','session_user','some','symmetric','table',
  'then','to','trailing','true','union','unique','user','using','variadic','when','where','window','with',
  /* reserved (can be function or type): */ 'authorization','binary','collation','concurrently','cross',
  'current_schema','freeze','full','ilike','inner','is','isnull','join','left','like','natural','notnull',
  'outer','overlaps','right','similar','tablesample','verbose'];

/** Tier 3 — JS/JSON/HTTP hazards. */
export const HAZARD_SLUGS: readonly string[] = [
  '__proto__', 'constructor', 'prototype', 'tostring', 'valueof', 'hasownproperty',
  'id', 'type', 'slug', 'values', 'value', 'filter', 'sort', 'cursor', 'limit', 'q', 'fields', 'include',
];
```

Tier 3 is the non-obvious one and it earns its place twice. `__proto__` matters because the API's
hydration payload is `Record<slug, value>`; an attribute slugged `__proto__` turns a JSON body into a
prototype-pollution vector on any consumer that does `Object.assign({}, body)`. `filter`/`sort`/`limit`
matter because §7 serialises filters into the query string keyed by slug — a slug called `sort` would
be ambiguous with the sort parameter.

Tier 1 is **computed from `SYSTEM_FIELDS`** rather than typed out, which means adding a derived column
(say `intro_count`) automatically reserves its slug. That is the anti-drift property; a hand-maintained
list would be wrong within two stages.

**Rejected alternative — allow anything and quote everything.** It removes a user-facing error at
creation time and buys three permanent hazards (promotion path, prototype pollution, query-string
ambiguity). The error message ("`sort` is a reserved name — try `sort_order`") is cheap and one-time.

### 4.4 Unit tests — slugs

| Test | Assertion |
|---|---|
| `suggest.basic` | `"Check size"` → `check_size`; `"E-Mail Adresse"` → `e_mail_adresse` |
| `suggest.folds` | `"Größe"` → `groesse` (not `grosse`, not `gr_e`); `"Café ☕"` → `cafe` |
| `suggest.leading-digit` | `"2nd degree"` → `f_2nd_degree` |
| `suggest.empty-input` | `"☕☕"` → `f_1` (never returns `''`) |
| `suggest.dedupe` | with `taken = {city, city_2}`, `"City"` → `city_3` |
| `suggest.deterministic` | same input + same `taken` ⇒ same output, 1 000 iterations |
| `suggest.length-cap` | a 200-character title yields ≤ 63 code points and matches the DB regex |
| `suggest.dedupe-at-cap` | a 63-character slug that is taken yields a 63-character `…_2`, still ≤ 63 |
| `validate.rejects` | `Cities` (upper), `city name` (space), `city-name` (dash), `2city`, `''`, 64 chars |
| `validate.reserved.tier1` | `display_name`, `warmth`, `open_followups` rejected with `reserved_slug` |
| `validate.reserved.tier2` | `select`, `order`, `user` rejected |
| `validate.reserved.tier3` | `__proto__`, `filter`, `id` rejected |
| `validate.reserved.derived` | property test: every slug in `SYSTEM_FIELDS[o]` is reserved for `o` |
| `validate.matches-db-regex` | property test over 10 000 random titles: `suggestSlug` output always matches `/^[a-z][a-z0-9_]{0,62}$/` |

---

## 5. Fields: one namespace over attributes, system columns and derived columns

The DataTable, the filter picker and the compiler must not know whether `warmth` is an attribute, a
column on `contact` or a column on `contact_metrics`. One resolver, three sources:

```ts
// fields/resolve.ts
export type FieldSource =
  | { readonly kind: 'attribute'; readonly def: AttributeDefinition }
  | { readonly kind: 'column';    readonly table: 'record' | 'contact' | 'organization'; readonly column: SystemColumn; readonly valueKind: ValueKind }
  | { readonly kind: 'metric';    readonly table: 'contact_metrics' | 'organization_metrics'; readonly column: MetricColumn; readonly valueKind: ValueKind };

export interface FieldDescriptor {
  readonly slug: string;
  readonly label: string;
  readonly source: FieldSource;
  readonly operators: readonly OperatorId[];
  readonly sortable: boolean;
  readonly readOnly: boolean;          // derived + system columns are read-only in the table
  readonly group?: string;             // brief 4.2 `group`, drives the detail sidebar
}

export interface FieldResolver {
  get(slug: string): FieldDescriptor | undefined;
  list(): readonly FieldDescriptor[];
}

export function makeFieldResolver(
  objectType: ObjectType,
  attributes: readonly AttributeDefinition[],
): FieldResolver;
```

`SystemColumn` and `MetricColumn` are closed unions of literals declared in `fields/system.ts`:

```ts
export const SYSTEM_FIELDS = {
  contact: [
    { slug: 'display_name',          table: 'contact', column: 'display_name', valueKind: 'text',
      operators: ['contains','equals','is_empty','is_not_empty'], sortable: true },
    { slug: 'first_name',            table: 'contact', column: 'first_name',  valueKind: 'text' },
    { slug: 'last_name',             table: 'contact', column: 'last_name',   valueKind: 'text' },
    { slug: 'created_at',            table: 'record',  column: 'created_at',  valueKind: 'date',
      operators: ['before','after','between','in_relative','older_than','newer_than'], sortable: true },
    { slug: 'updated_at',            table: 'record',  column: 'updated_at',  valueKind: 'date' },
    { slug: 'created_via',           table: 'record',  column: 'created_via', valueKind: 'text' },
    { slug: 'import_batch_id',       table: 'record',  column: 'import_batch_id', valueKind: 'text' },
    // 4.7 / 5.2 derived - declared here so they appear in the Columns picker like any attribute
    { slug: 'warmth',                table: 'contact_metrics', column: 'warmth', valueKind: 'number',
      operators: ['eq','neq','lt','gt','between'], sortable: true, derived: true },
    { slug: 'last_interaction_at',   table: 'contact_metrics', column: 'last_interaction_at', valueKind: 'date',
      operators: ['before','after','between','in_relative','older_than','newer_than','is_empty','is_not_empty'],
      sortable: true, derived: true },
    { slug: 'interaction_count_12m', table: 'contact_metrics', column: 'interaction_count_12m', valueKind: 'number' },
    { slug: 'open_followups',        table: 'contact_metrics', column: 'open_followups', valueKind: 'number' },
    { slug: 'next_followup_at',      table: 'contact_metrics', column: 'next_followup_at', valueKind: 'date' },
    { slug: 'pinned_important',      table: 'contact', column: 'pinned_important', valueKind: 'bool' },
    { slug: 'not_important',         table: 'contact', column: 'not_important',   valueKind: 'bool' },
  ],
  organization: [ /* name, created_at, updated_at, created_via, people_count, last_interaction_at */ ],
  interaction:  [ /* type, occurred_at, title, source */ ],
} as const;
```

Every `column` value is a literal in a frozen allowlist, so **no user-supplied string can become a SQL
identifier** - the property test in section 6.6 asserts this by construction.

`makeFieldResolver` rejects a collision between a system slug and an attribute slug at construction
time (it cannot happen, because section 4.3 reserves them, but the resolver asserting it turns a data
bug into a startup failure rather than a silently shadowed column).

---

## 6. The filter model and the compiler

### 6.1 The union - discriminated on the operator

```ts
// filters/model.ts
export const OPERATORS = [
  'contains', 'equals',
  'is_empty', 'is_not_empty',
  'eq', 'neq', 'lt', 'gt', 'between',
  'before', 'after', 'in_relative', 'older_than', 'newer_than',
  'is_yes', 'is_no',
  'is_one_of', 'is_not_one_of',
  'contains_any_of', 'contains_all_of',
  'has_any_of',
] as const;
export type OperatorId = (typeof OPERATORS)[number];

export type Filter =
  | { readonly field: string; readonly op: 'contains' | 'equals';        readonly value: string }
  | { readonly field: string; readonly op: 'is_empty' | 'is_not_empty' }
  | { readonly field: string; readonly op: 'eq' | 'neq' | 'lt' | 'gt';   readonly value: string }
  | { readonly field: string; readonly op: 'between';                    readonly from: string; readonly to: string }
  | { readonly field: string; readonly op: 'before' | 'after';           readonly value: string }
  | { readonly field: string; readonly op: 'in_relative';                readonly preset: RelativePreset }
  | { readonly field: string; readonly op: 'older_than' | 'newer_than';  readonly days: number }
  | { readonly field: string; readonly op: 'is_yes' | 'is_no' }
  | { readonly field: string; readonly op: 'is_one_of' | 'is_not_one_of' | 'contains_any_of'
                                         | 'contains_all_of' | 'has_any_of'; readonly values: readonly string[] };

/** AND-only, per storage-DECISION 1.5 and brief 5.2. `all` is a key, not a boolean, so that
 *  adding `{ any: Filter[] }` later is additive to the wire format. */
export interface FilterSet { readonly all: readonly Filter[] }

export const filterSchema = z.discriminatedUnion('op', [ /* one z.object per variant */ ]);
export const filterSetSchema = z.object({ all: z.array(filterSchema).max(20) });
```

Three deliberate properties:

1. **Arity is in the type system.** `{ op: 'is_empty' }` has no `value` field at all - it is
   impossible to construct a well-typed `is_empty` filter carrying a value, and impossible to forget
   `to` on a `between`. Zod 4's `z.discriminatedUnion` gives the same guarantee at the API boundary,
   with a good error message. **Verified:** Zod 4 upgraded discriminated unions to support more member
   schema types and to compose (a discriminated union may be a member of another) - relevant if `any`
   is added later.
2. **The payload is always `string` / `string[]` / `number`.** A date is `'2026-03-01'`, a number is
   `'600000'`, a select is an option **key**, a tag is its normalised value, a relation is a record
   uuid. So the query-string codec is lossless without escaping types, and the *interpretation* is the
   resolved field's job. `validateFilter(filter, field)` is the second stage: it checks the operator is
   in `field.operators` (else `operator_not_allowed`) and runs the value through the type's `coerce`
   (else the type's own issue code).
3. **Relative operators are first-class**, not sugar over `before`/`after`. `older_than: 90` on
   `last_interaction_at` is what a saved view stores. Resolving it to `'2026-06-05'` at save time
   would freeze the view - the exact bug that makes "No interaction in 90 days" (a brief-mandated
   seeded view, 6.2) quietly wrong a week later.

**Rejected alternative - discriminate on the field's type** (`{ kind: 'text', field, op, value }`).
It duplicates information the resolver already has, and it goes stale the moment a field's type
changes - which the brief forbids anyway, so the duplication buys nothing and adds a way to disagree.

**Rejected alternative - `{ field, op, value: unknown }`.** Trivially serialisable, and it moves
every arity mistake from compile time to runtime. The filter compiler is the one piece of this system
the brief singles out as "breaks silently"; giving it a stringly-typed input is the wrong direction.

`RelativePreset` is a closed union:
`'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'last_90_days' | 'this_month' |
'last_month' | 'this_year' | 'last_year' | 'next_7_days' | 'next_30_days' | 'next_90_days'`
resolved by `resolveRelative(preset, today): { from: CivilDate; to: CivilDate }`. Future-facing presets
exist because follow-up due dates need them.

### 6.2 Query-string serialisation

```ts
// filters/serialize.ts
export function serializeFilters(set: FilterSet): readonly string[];   // one string per condition
export function parseFilters(raw: readonly string[]): Result<FilterSet>;
export function serializeSort(s: SortRequest | null): string | null;   // "check_size:desc"
export function parseSort(raw: string): Result<SortRequest>;
```

Grammar: `field ":" op [ ":" payload ]`, payload split on unescaped `,`, each part percent-encoded.
Slugs match `[a-z][a-z0-9_]{0,62}` and operators come from a closed set, so neither can contain `:` -
the parser splits on the first two colons only and everything after is payload.

```
?filter=job_role:is_one_of:investor,angel
&filter=city:contains:m%C3%BCnchen
&filter=areas_of_interest:contains_any_of:climate%20tech,energy
&filter=last_interaction_at:older_than:90
&filter=check_size:between:250000,1000000
&sort=check_size:desc&limit=50&cursor=...
```

**Rejected alternative - one JSON parameter** (`?filter={"all":[...]}`). More robust to escape and
trivially OpenAPI-describable. Rejected because 5.2 makes the URL a first-class product surface
("Filters are reflected in the URL so views can be shared/bookmarked"): a URL a person can read, hand-
edit and paste into a chat is worth the escaping rules, and one condition per parameter means the
DataTable adds and removes a chip by adding and removing a parameter, never by re-serialising a blob.
The escaping rules are pinned by a round-trip property test (below), which is what actually makes this
safe.

### 6.3 The compiler

```ts
// filters/compile.ts
export interface SqlFragment { readonly sql: string; readonly params: readonly SqlParam[] }
export type SqlParam = string | number | boolean | null | readonly string[];

export interface CompileContext {
  readonly objectType: ObjectType;
  readonly fields: FieldResolver;
  readonly workspaceId: Uuid;
  readonly today: CivilDate;      // relative operators resolve against this
  readonly now: Date;             // timestamp columns
}

export interface ListQueryRequest {
  readonly filters: FilterSet;
  readonly search?: { readonly q: string; readonly fields: readonly string[] };
  readonly sort?: { readonly field: string; readonly direction: 'asc' | 'desc' } | null;
  readonly page: { readonly limit: number; readonly offset: number };
}

/** Q1 - filter + sort + paginate. Returns (id, sort_key) only. */
export function compileRowsQuery(ctx: CompileContext, req: ListQueryRequest): Result<SqlFragment>;
/** Q3 - the footer count: same WHERE, no sort, no join to the sort attribute. */
export function compileCountQuery(ctx: CompileContext, req: ListQueryRequest): Result<SqlFragment>;
/** Q2 - hydrate the surviving ids. */
export function compileHydrateQuery(ctx: CompileContext, ids: readonly Uuid[], visible: readonly string[]): SqlFragment;
/** One condition, exported so it can be unit-tested and reused by the ask-the-network path. */
export function compileCondition(ctx: CompileContext, f: Filter): Result<SqlFragment>;
```

**Core emits Postgres SQL text.** Two alternatives were weighed:

- *An abstract query IR compiled to SQL in `packages/db`.* Purest, and genuinely defensible. Rejected
  because the brief names "filter to query compilation" as domain logic to unit-test with high
  coverage (8.1), and an IR splits that logic across two packages so that neither half's tests prove
  the emitted SQL is right. It also doubles the number of places that must agree about, for example,
  whether `is empty` is `NOT EXISTS` or a `LEFT JOIN ... IS NULL`.
- *Return drizzle `SQL` objects.* Couples the domain package to `drizzle-orm@0.45.2` - a v0 line with
  a v1 beta stream in flight - and makes every compiler unit test import an ORM. Rejected.

The coupling being accepted is explicit: **core emits Postgres 16 dialect**, and says so in its README.
Postgres is fixed by the brief, so this costs nothing today.

Parameter numbering is handled by a builder so fragments compose without renumbering:

```ts
class ParamBuilder {
  #params: SqlParam[] = [];
  add(v: SqlParam): string { this.#params.push(v); return `$${this.#params.length}`; }
  get params(): readonly SqlParam[] { return this.#params; }
}
```

Every attribute predicate is wrapped in the semi-join shape from storage-DECISION 5.3:

```ts
const wrap = (inner: string) =>
  `EXISTS (SELECT 1 FROM attribute_value v WHERE v.record_id = r.id AND v.attribute_id = ${a} AND ${inner})`;
```

and the per-operator bodies are a single closed switch (excerpt - the full table is 5.3 of the storage
decision, transcribed once, here, and nowhere else):

```ts
switch (f.op) {
  case 'contains':
    return wrap(`v.${col.norm} LIKE ${p.add('%' + escapeLike(normalizeText(f.value)) + '%')}`);
  case 'equals':
    // indexed prefix + exact recheck (storage 9.5.6: truncation is never load-bearing)
    return wrap(`v.${col.sort} = ${p.add(sortKey(normalizeText(f.value), false))}
                 AND v.${col.norm} = ${p.add(normalizeText(f.value))}`);
  case 'is_empty':
    return `NOT ${wrap('TRUE')}`;
  case 'is_not_empty':
    return wrap('TRUE');
  case 'between':
    return wrap(`v.${col.value} BETWEEN ${p.add(lo)}::${pgType} AND ${p.add(hi)}::${pgType}`);
  case 'is_one_of':
    return wrap(`v.option_id = ANY(${p.add(optionIds)}::uuid[])`);
  case 'is_not_one_of':
    return `NOT ${wrap(`v.option_id = ANY(${p.add(optionIds)}::uuid[])`)}`;   // includes empties, storage 3.4
  case 'contains_all_of':
    return `(SELECT count(DISTINCT v2.option_id) FROM attribute_value v2
              WHERE v2.record_id = r.id AND v2.attribute_id = ${a}
                AND v2.option_id = ANY(${ids}::uuid[])) = ${p.add(optionIds.length)}`;
  case 'older_than':
    return `(m.${column} IS NOT NULL AND m.${column} < now() - ${p.add(f.days)} * interval '1 day')`;
  // ...
  default: return assertNever(f);
}
```

Four details that are easy to get wrong and are therefore pinned by tests:

1. **Option keys, not uuids, on the wire.** A filter carries `investor`; the compiler resolves it
   through `field.def` options to the uuid before binding. Keys are stable across re-seeds, readable
   in a URL and survive a label rename; uuids are none of those. An unknown key is `unknown_option`,
   a 400, not an empty result.
2. **Tags are matched on `value_key`**, so the compiler normalises the needle with the *same*
   `normalizeText` / `valueKey` the writer used. This is the concrete payoff of section 2.4: one
   function, one answer.
3. **`older_than` emits `IS NOT NULL AND ...`**, so a contact you have never interacted with is not
   "last interaction more than 90 days ago". See open question 1 - this changes what the seeded view
   "No interaction in 90 days" shows.
4. **The table search box compiles to one `EXISTS` with an attribute-id array**, never to an `OR` of
   several `EXISTS` (storage 5.3): an `OR` between semi-joins defeats the sublink pull-up.

### 6.4 Sort

```ts
// sort/compile.ts
export function compileSort(
  ctx: CompileContext, field: FieldDescriptor, direction: 'asc' | 'desc',
): Result<{ readonly joins: readonly SqlFragment[]; readonly orderBy: SqlFragment }>;
```

- Rule: **`ORDER BY <key> <dir> NULLS LAST, r.id <dir>`** - `NULLS LAST` in both directions so "empty"
  is always at the bottom and the plan shape does not change between ascending and descending; `r.id`
  makes the order total so pagination is stable.
- `{ via: 'slot' }` emits `LEFT JOIN attribute_value sv ON sv.record_id = r.id AND sv.attribute_id = $a
  AND sv.value_key = ''` (a plain LEFT JOIN, not a LATERAL - safe because `av_record_attr_uq`
  guarantees at most one row for a single-valued attribute).
- `{ via: 'option-position' }` adds a second `LEFT JOIN attribute_option so ON so.id = sv.option_id`
  and orders by `so.position`.
- `invert: true` (only `yes_no`) flips the emitted direction, so an ascending click puts yes first.
- `sort === null` gives a `Result` error `not_sortable`, which the API returns as 400. Explicit
  refusal, never a silent fallback to insertion order.

### 6.5 What the compiler refuses

| Situation | Issue code | Why it must be a refusal, not a fallback |
|---|---|---|
| unknown field slug | `unknown_field` | a typo in a saved view must be visible, not silently ignored |
| operator not in `field.operators` | `operator_not_allowed` | `contains` on a `date` would otherwise become a text scan |
| `contains` with fewer than 3 characters | *warning*, still compiles | `gin_trgm_ops` needs 3 characters to extract a trigram; below that it is a full index scan. It compiles, but the field descriptor carries `minSubstringLength: 3` so the UI can wait for the third keystroke |
| sort on a non-sortable type | `not_sortable` | the brief's 4.2 dash column |
| more than 20 conditions | `too_many_filters` | past `join_collapse_limit = 16` and into GEQO territory (storage 5.4) |
| unknown option key / unparseable value | the type's own code | surfaces as a per-field validation error |

### 6.6 Unit tests - filters and the compiler

These are the highest-value tests in the package. Target: **at least 60 cases**, no database.

| Group | Tests |
|---|---|
| **Golden SQL** | one per (type, operator) pair from the brief's 4.2 table - 12 types times their operators, about **45 cases** - each asserting the exact `sql` string *and* the exact `params` array. Golden strings live inline, not in snapshot files, so a diff is readable in review |
| **Derived columns** | 5 more: `warmth between`, `last_interaction_at older_than`, `interaction_count_12m gt`, `open_followups eq 0`, `people_count gt` |
| **System columns** | `display_name contains`, `created_at in_relative:this_year`, `import_batch_id eq` |
| **Composition** | 3 chips plus search plus sort produces one statement with sequential `$1..$n`, no gaps; `params.length` equals the highest placeholder |
| **Injection (property test)** | for 1000 random hostile strings (`'; DROP TABLE record;--`, `%`, `_`, backslash, 10 kB of quotes), assert the input substring **never** appears in `fragment.sql` and always appears verbatim in `fragment.params` |
| **Identifier allowlist** | property test: every identifier token in emitted SQL (regex over the string) is in a frozen allowlist of table names, alias names and `ALL_SLOT_COLUMNS` |
| **LIKE escaping** | `contains "50%"` binds `%50\%%`, and `escapeLike` escapes the backslash before `%` and `_` (order matters; the wrong order double-escapes) |
| **Normalisation agreement** | for 200 random strings, the needle bound by `contains` equals `normalizeText(input)` - the same function the writer uses |
| **Option resolution** | `is_one_of` with keys binds a uuid array; unknown key gives `unknown_option`; an archived option still resolves, so an old saved view keeps working |
| **Relative presets** | all 12 presets against a leap-year date, a 31 Dec date and a 1 Jan date, asserting exact bounds |
| **`is_empty` uniformity** | for all 12 types, `is_empty` compiles to `NOT EXISTS (...)` over `attribute_value` (or `record_link` for `relation`) - one shape, no per-type special case |
| **Refusals** | every row of the 6.5 table returns the stated issue code |
| **Round-trip (property test)** | 5000 random `FilterSet`s: `parseFilters(serializeFilters(x))` deep-equals `x`; includes values containing `,`, `:`, `%`, `+`, emoji and empty strings |
| **Sort** | `NULLS LAST` present in both directions for all sortable types; `yes_no` ascending emits `DESC`; `single_select` emits the option join; `long_text` gives `not_sortable` |
| **Saved-view stability** | a view serialised today and parsed with a `today` 400 days later resolves `older_than:90` to a *different* absolute bound - i.e. the relative filter did not freeze |

---

## 7. Warmth

### 7.1 The arithmetic, in full

The brief (4.7) fixes everything except `k`:

```
signal = SUM over interactions in the last 365 days of weight(type) * exp(-days_ago / 90)
weight: Meeting 3.0, Call 2.5, Event 2.0, Intro 2.0, Note 1.5, Message 1.0, Email 0.7
warmth = round(100 * (1 - exp(-k * signal)))          choose k so one meeting per month is about 75
```

"One meeting per month" over 365 days, measured at the moment of a meeting, is meetings at
`days_ago = 0, 30, 60, ..., 360` - thirteen of them (360 <= 365):

```
signal = 3.0 * SUM(n=0..12) exp(-30n/90) = 3.0 * SUM(n=0..12) r^n,  r = exp(-1/3) = 0.7165313
       = 3.0 * (1 - r^13) / (1 - r)
       = 3.0 * (1 - 0.0131152) / 0.2834687
       = 3.0 * 3.4816360
       = 10.4449079
```

`warmth = 75` requires `exp(-k * signal) = 0.25`, i.e. `k * signal = ln 4`:

```
k = ln 4 / 10.4449079 = 1.3862944 / 10.4449079 = 0.13273534
```

**k = 0.13273534** (matching storage-DECISION 7.1's `ln 4 / 10.445 = 0.1327`). It is a single exported
constant, `WARMTH_K`, with the derivation in a comment above it.

### 7.2 Which point in the cycle "one meeting per month" means - a real choice

A monthly cadence does not have one warmth; it oscillates as the exponential decays between meetings.

| calibration point | signal | resulting k | warmth just after a meeting | warmth just before the next |
|---|---|---|---|---|
| **at the meeting (chosen)** | 10.4449 | **0.132735** | **75** | 63 |
| just before the next meeting | 7.4449 | 0.186212 | 86 | 75 |
| average across the cycle | ~9.0 | ~0.157 | 80 | 68 |

**Chosen: at the meeting.** Reasons: (a) it is the reading a user gets when they look at a contact
right after logging the meeting, which is when they look; (b) it keeps the whole scale conservative,
and warmth will later drive stay-in-touch nudges (brief section 9) where an inflated score means a
missed nudge, a worse failure than an extra one; (c) it is the number the storage decision already
committed to, and two documents disagreeing about `k` would be worse than either value.

**The 63-to-75 swing across a month is real and is documented in the UI copy**: the warmth indicator
tooltip says "how alive this relationship is right now", not "how often you meet". A reviewer will
notice the swing; better that it is written down than discovered.

### 7.3 Signature and the decisions inside it

```ts
// warmth.ts
export const INTERACTION_WEIGHTS = {
  Meeting: 3.0, Call: 2.5, Event: 2.0, Intro: 2.0, Note: 1.5, Message: 1.0, Email: 0.7,
} as const satisfies Record<InteractionType, number>;

export const WARMTH_HALF_LIFE_DAYS = 90;     // the brief's exp(-days_ago / 90)
export const WARMTH_WINDOW_DAYS    = 365;
export const WARMTH_K              = 0.13273534;

export interface WarmthInteraction {
  readonly type: InteractionType;
  readonly occurredOn: CivilDate;            // civil, in the profile timezone
}
export interface WarmthOverrides {
  readonly pinnedImportant: boolean;         // floor 60
  readonly notImportant: boolean;            // cap 10
}
export interface WarmthResult {
  readonly warmth: number;                   // 0..100 integer
  readonly rawWarmth: number;                // before overrides - shown in the "why" popover later
  readonly signal: number;                   // for tests and debugging
  readonly counted: number;                  // interactions inside the window
}

export function computeWarmth(
  interactions: readonly WarmthInteraction[],
  overrides: WarmthOverrides,
  today: CivilDate,
): WarmthResult;
```

Six decisions that the formula does not state and a test must pin:

1. **`days_ago` is whole days on civil dates**, `diffDays(today, occurredOn)`, not fractional
   milliseconds. Consequence: the nightly sweep produces the *same* number for a contact whose
   interactions have not changed, so the write-back only touches rows whose warmth actually moved.
   Fractional days would rewrite all 10 000 `contact_metrics` rows every night for no information -
   more WAL, more vacuum, and a "warmth changed" audit trail that means nothing.
2. **Window:** an interaction counts when `0 <= days_ago <= 365`. The boundary is inclusive and tested
   at exactly 365 and 366.
3. **Future interactions** (`days_ago < 0`, a meeting logged for next week) are **clamped to 0**, not
   dropped: a scheduled meeting is a real signal, and dropping it would make warmth fall when you
   book time with someone.
4. **Unknown interaction type** contributes weight 0 rather than throwing. The database CHECK makes it
   impossible today; totality makes the function safe for the LLM path in Stage 6.
5. **Override order:** `min(notImportant ? 10 : 100, max(pinnedImportant ? 60 : 0, raw))`. If both
   flags are set - which the UI should prevent but the API cannot - the **cap wins** and the contact
   scores 10. Rationale: `not_important` also means "exclude from nudges", and the safe failure is to
   stay quiet.
6. **Rounding is `Math.round` on the 0-100 scale**, applied before the overrides so the floor and cap
   are exact integers.

The nightly job is: one aggregate query, this function, one batched write-back (storage 7.1). There is
**no second implementation in SQL**; a SQL version would drift from this one within two stages and
nothing would notice.

### 7.4 Unit tests - warmth

| Test | Assertion |
|---|---|
| `k.calibration` | 13 monthly meetings at `days_ago = 0..360` gives exactly **75** (and `signal` within 1e-6 of 10.4449079) |
| `k.constant` | `WARMTH_K` equals `Math.log(4) / 10.4449079` to 8 decimals - so a hand edit of the constant fails |
| `calibration.table` | the full table below, each to the exact integer |
| `window.boundary` | one meeting at 365 days counts; at 366 it does not |
| `future.clamped` | a meeting dated tomorrow scores identically to one dated today |
| `weights.match-brief` | `INTERACTION_WEIGHTS` deep-equals the brief's seven weights |
| `monotonic` | property test: adding any interaction never decreases warmth; moving an interaction further into the past never increases it |
| `bounds` | property test over 10 000 random inputs: `0 <= warmth <= 100` and integral |
| `overrides.floor` | raw 12, pinned gives 60 |
| `overrides.cap` | raw 90, notImportant gives 10 |
| `overrides.both` | raw 90, both flags gives 10 |
| `empty` | no interactions gives 0, `counted` 0 |
| `determinism` | same input twice gives an identical object (no clock read) |

The calibration table, which is both a doc table and the test fixture:

| Cadence | signal | warmth |
|---|---|---|
| weekly meetings (53 in the window) | 39.44 | **99** |
| fortnightly meetings | 20.52 | **93** |
| **monthly meetings, at the meeting** | **10.44** | **75** |
| monthly meetings, day 29 of the cycle | 7.44 | **63** |
| weekly messages (weight 1.0) | 13.15 | **83** |
| quarterly meetings | 4.71 | **47** |
| two meetings a year | 3.40 | **36** |
| one meeting today, nothing else | 3.00 | **33** |
| monthly emails (weight 0.7) | 2.44 | **28** |
| one meeting six months ago | 0.40 | **5** |
| nothing in 365 days | 0 | **0** |

"One meeting today and nothing else scores 33" is the sanity check that matters: a single touch does
not make somebody a warm contact.

---

## 8. Identity: normalisation and duplicate matching

### 8.1 Identifier normalisation

```ts
// identity/*.ts
export type IdentifierKind = 'email' | 'phone' | 'linkedin_url' | 'website'
                           | 'google_contact_id' | 'telegram' | 'whatsapp' | 'other';

export interface NormalizedIdentifier {
  readonly kind: IdentifierKind;
  readonly value: string;      // what goes into identifier.value - already canonical
  readonly display: string;    // what the attribute stores and the UI shows
  readonly confidence: number; // per-kind identity strength, used by matchDuplicates
}

export function normalizeEmail(raw: string): Result<{ identifier: string; display: string; matchKey: string }>;
export function normalizePhone(raw: string, opts: { defaultRegion?: CountryCode }):
  Result<{ e164: string; national: string; region?: CountryCode; type?: PhoneType; valid: boolean }>;
export function normalizeLinkedIn(raw: string): Result<{ identifier: string; url: string; kind: 'person' | 'company' | 'school' }>;
export function normalizeWebsite(raw: string): Result<{ identifier: string; url: string; host: string }>;
```

**Email.** Strip `mailto:`, surrounding angle brackets, zero-width characters; NFKC; trim; require
exactly one `@`; punycode the domain by round-tripping it through `new URL('http://' + domain).hostname`
(no IDN dependency); lower-case the whole address for `identifier`; keep the user's original for
`display`. Validation uses Zod 4's `z.email()`.

`matchKey` is a **second, looser key that is never stored as an identifier**: `+tag` removed from the
local part for every domain, and dots removed for `gmail.com` / `googlemail.com` (which are the same
mailbox). It exists only as a duplicate-detection *signal* (rule `email_local_match`, 0.85).

- **Rejected:** folding `matchKey` into the stored identifier. `identifier.value` is `UNIQUE`; folding
  would make `anna+crm@x.com` and `anna@x.com` collide permanently, and a user who deliberately keeps
  two addresses could never store the second one.

**Phone.** `parsePhoneNumberWithError` from `libphonenumber-js/max` (verified: `/max` is the bundle that
carries validation and type detection; `.number` is the E.164 string). If the input has no `+` and no
`defaultRegion` is configured, the result is `Result.err('ambiguous_national_number')` - and the caller
**still stores the raw text as the attribute value**, just without writing an identifier. A CRM must
never lose a phone number because it could not classify it.

`defaultRegion` comes from a new `profile.phone_region` field (ISO-3166 alpha-2, seeded `DE`). The
brief's Profile (6.6) has no such field; this is a small, reversible addition logged as an ADR rather
than a question, because a German user importing "089 1234567" needs it on day one.

**LinkedIn.** Accepts every real-world shape: a bare slug, `in/slug`, any host
(`www.` / `de.` / `m.` / `mwlite`), a query string, a trailing slash, percent-encoding, and the legacy
`/pub/<slug>/1a/2b/3c` form. Canonical `identifier` is `in/<slug>`, `company/<slug>` or `school/<slug>`,
lower-cased and percent-decoded; `url` is `https://www.linkedin.com/<identifier>`. A non-LinkedIn host
gives `invalid_linkedin_url`.

**Website.** Prepend `https://` when there is no scheme; parse with `URL`; reject non-http(s); host is
lower-cased, punycoded, `www.`-stripped, default port removed; **query and fragment are dropped
entirely** (utm parameters are the common case and a meaningful query string on a company homepage is
not). `url` keeps the path; `identifier` is the **host only**, so `northstar.vc/about` and
`northstar.vc` are the same organisation.

- **Rejected:** a public-suffix list (`tldts@7.4.11`) to reduce `blog.example.co.uk` to
  `example.co.uk`. It is a dependency, a data file with an expiry date, and it would merge
  `blog.example.com` into `example.com`, which is not obviously right. Host-level identity is
  predictable and explainable, and the only thing lost is that two records pointing at different
  subdomains of one company are not auto-linked.

### 8.2 Trigram similarity that agrees with the database

```ts
// text/trigram.ts
/** pg_trgm-compatible: split on non-alphanumerics, pad each word with two leading and one trailing space. */
export function trigrams(input: string): ReadonlySet<string>;
/** |A intersect B| / |A union B| - the Jaccard form pg_trgm's similarity() uses. */
export function trigramSimilarity(a: string, b: string): number;
```

**Verified** from the Postgres 16 documentation: `pg_trgm` ignores non-word (non-alphanumeric)
characters when extracting trigrams; each word is treated as having two spaces prefixed and one space
suffixed (`cat` gives `{"  c", " ca", "cat", "at "}`); comparisons are case-insensitive in a default
build; `pg_trgm.similarity_threshold` defaults to 0.3 and is what the `%` operator uses.
**Assumed and pinned by a test:** that the score is `|A ∩ B| / |A ∪ B|` over the de-duplicated trigram
sets. A Stage-1 integration test compares `trigramSimilarity` against `SELECT similarity($1,$2)` over a
100-pair fixture and fails on any divergence beyond 1e-6.

Why reimplement rather than let the database score: the database is used for **candidate generation**
(index-backed, `%`), and core does the **scoring**, because the brief requires duplicate matching to be
unit-tested domain logic with confidence scores, and because the same scorer must run in the import
preview where the candidate set is already in memory. Reimplementing a different metric (Jaro-Winkler,
Levenshtein) would mean the threshold used to fetch candidates and the threshold used to score them
disagree, which shows up as "the UI says 0.81 but the row was never offered".

**Candidate-generation recall note.** The storage decision's fallback query uses
`lower(r.display_label) % lower($name)`, which is lower-cased but not accent-folded, while core's
`nameKey` is folded. Two minimal fixes, both proposed here: (a) store `contact.name_key text` written
by the application (core computes it - consistent with section 2.4) with a btree index and a trigram
GIN, so exact-name matching is an index probe and fuzzy matching is folded on both sides; and (b)
until that exists, issue the candidate probe twice, with the folded and the merely-lower-cased needle,
and union the results. (a) is one column and two indexes and is the recommendation.

### 8.3 Name keys

```ts
// text/names.ts
export function personNameKey(first: string | null, last: string | null, full?: string): string;
export function organizationNameKey(name: string): string;
export function isInitialForm(a: string, b: string): boolean;
```

`personNameKey`: `normalizeText` the full name, drop honorifics (`dr`, `prof`, `mr`, `mrs`, `ms`, `mag`,
`ing`, `dipl`, `phd`, `md`) and suffixes (`jr`, `sr`, `ii`, `iii`, `mba`, `msc`, `bsc`), drop
punctuation, **sort the remaining tokens** and join with a single space. Sorting handles the very common
`"Berger, Anna"` and `"Berger Anna"` orderings that CSV exports produce, at the cost of conflating
"Anna Berger" with a hypothetical "Berger Anna" - which is the same person anyway.

`organizationNameKey`: `normalizeText`, then strip a trailing legal form
(`gmbh`, `mbh`, `ag`, `kg`, `gmbh & co kg`, `ug`, `ev`, `inc`, `llc`, `ltd`, `plc`, `sa`, `sarl`, `bv`,
`nv`, `oy`, `ab`, `as`, `aps`, `spa`, `srl`, `pty`, `co`, `corp`, `company`, `holding`, `group`,
`ventures`? **no** - `ventures` is part of the name), and a leading `the`. Tokens are **not** sorted for
organisations (word order carries meaning: "Northstar Ventures" is not "Ventures Northstar").

### 8.4 Duplicate matching - identifiers first, always

```ts
// identity/duplicates.ts
export interface DuplicateInput {
  readonly objectType: 'contact' | 'organization';
  readonly nameKey: string;
  readonly displayName: string;
  readonly identifiers: readonly NormalizedIdentifier[];
  readonly emailMatchKeys: readonly string[];
  readonly organizationIds: readonly Uuid[];      // current links only
  readonly organizationNameKeys: readonly string[];
  readonly cityNorm?: string;
}

/** What the caller fetched from the database. Core does no I/O. */
export interface CandidatePool {
  /** Exact hits on identifier(kind, value) - one indexed probe per identifier. */
  readonly identifierHits: readonly { recordId: Uuid; kind: IdentifierKind; value: string; phoneType?: PhoneType }[];
  /** Name-similarity hits, fetched ONLY when identifierHits is empty. */
  readonly nameCandidates: readonly {
    recordId: Uuid; nameKey: string; displayName: string;
    organizationIds: readonly Uuid[]; organizationNameKeys: readonly string[];
    cityNorm?: string; emailMatchKeys: readonly string[];
  }[];
}

export type MatchBand = 'certain' | 'probable';
export interface DuplicateMatch {
  readonly recordId: Uuid;
  readonly confidence: number;      // 0..1
  readonly band: MatchBand;
  readonly rules: readonly RuleId[];
  readonly evidence: string;        // "Same email: anna@northstar.vc" - shown on the chip
}
export interface DuplicateVerdict {
  readonly best: DuplicateMatch | null;
  readonly matches: readonly DuplicateMatch[];   // sorted by confidence desc, max 5
  readonly usedFallback: boolean;                // true only when no identifier matched
}

export function matchDuplicates(input: DuplicateInput, pool: CandidatePool): DuplicateVerdict;
```

**Stage 1 - identifiers.** Per-kind identity strength, which is the whole point of scoring rather than
returning a boolean:

| kind | confidence | why not 1.0 |
|---|---|---|
| `google_contact_id` | 0.99 | a provider's own primary key |
| `linkedin_url` (person) | 0.99 | one profile is one person |
| `telegram`, `whatsapp` | 0.95 | reserved for later channels |
| `email` | 0.97 | shared family and role addresses exist (`info@`, `team@`) |
| `phone`, type `MOBILE` | 0.93 | rarely shared |
| `phone`, other or unknown type | 0.80 | landlines are shared by households and switchboards |
| `website` on an **organization** | 0.95 | close to definitive for a company |
| `website` on a **contact** | **0.00** | colleagues share a company website - this is not identity, and treating it as identity would merge whole teams into one person |

Multiple independent identifier hits on the same record combine noisy-or,
`1 - PRODUCT(1 - c_i)`, capped at 0.995. Email plus mobile gives 0.998.

**Stage 2 - fallback, evaluated only when `identifierHits` is empty**, exactly as 4.6 demands
("name + organization similarity is the fallback, never the first check"). An ordered rule table; the
first matching rule wins, so every result has one explainable reason:

| rule id | condition | confidence | evidence |
|---|---|---|---|
| `name_exact_org_same` | `nameKey` equal and at least one shared **current** organisation | 0.88 | "Same name, both at Northstar Ventures" |
| `email_local_match` | a shared `emailMatchKey` (plus-tag or gmail-dot variant) | 0.85 | "anna.berger+crm@gmail.com matches annaberger@gmail.com" |
| `name_fuzzy_org_same` | `trigramSimilarity >= 0.75` and a shared current organisation | 0.74 | "Similar name, both at Northstar Ventures" |
| `name_initial_org_same` | one name is the initial form of the other, shared organisation | 0.70 | "A. Berger and Anna Berger, both at Northstar" |
| `name_exact_city_same` | `nameKey` equal, no organisation on either side, same normalised city | 0.66 | "Same name, both in Munich" |
| `name_exact_org_unknown` | `nameKey` equal, neither record has any organisation | 0.62 | "Same name, no organisation on either record" |
| `name_exact_org_diff` | `nameKey` equal, both have organisations, none shared | 0.30 | not surfaced - two different people with one name |

Bands: **`certain` at >= 0.95**, **`probable` at 0.60-0.949**, below 0.60 not surfaced at all.

- **Rejected: a weighted score** (`0.55*nameSim + 0.35*orgAgreement + 0.10*cityAgreement`). There is no
  labelled data to fit the weights, so the numbers would be invented and then trusted; and the import
  UI has to print a *reason* on the chip ("Possible duplicate of Anna Berger" needs a because).
  A rule table produces the reason for free and each rule is one unit test.
- **Rejected: letting the LLM adjudicate.** The brief forbids it in as many words: "matching free text
  to an existing contact is done by deterministic code with confidence scores ... never by the model
  alone."
- **Rejected: Jaro-Winkler / Levenshtein** for the name metric. Better for typos in short strings, but
  it cannot be produced by an index probe, so candidate generation and scoring would use two different
  metrics (see 8.2).

**One implementation, three call sites.** The import review grid (6.8), the quick-capture preview
(4.8) and the merge dialog (6.9) all call `matchDuplicates`. The importer does not get its own
"is this the same person" logic - that is how the two drift.

### 8.5 Unit tests - identity

| Group | Tests |
|---|---|
| `email.normalize` | `" Anna.Berger@Example.COM "` gives `anna.berger@example.com`; `mailto:` stripped; `<a@b.c>` stripped; `münchen.de` domain punycoded; no `@` gives `invalid_email`; two `@` rejected; 320-char address rejected |
| `email.matchKey` | gmail dots and `+tag` folded; **non**-gmail dots preserved; `+tag` folded on every domain; `matchKey` never equals `identifier` when a tag was present |
| `phone.e164` | `"+49 89 1234567"`, `"089 1234567"` with region DE, `"(213) 373-4253"` with region US all give the right E.164; `"089 1234567"` with no region gives `ambiguous_national_number`; a letters-only string gives `invalid_phone`; German mobile gives type `MOBILE`, Berlin landline gives `FIXED_LINE` |
| `phone.preserves-raw` | an unparseable number still produces a display value for the attribute |
| `linkedin.canonical` | 8 input shapes (bare slug, `in/x`, `www.`, `de.`, `m.`, `/mwlite/in/`, trailing slash, `?originalSubdomain=de`) all give `in/anna-berger`; `/company/x` gives `company/x`; percent-encoded unicode slug decoded; `https://example.com/in/x` rejected |
| `website.canonical` | `Northstar.VC` gives `https://northstar.vc` and host `northstar.vc`; `www.` stripped; `:443` stripped; `?utm_source=x` dropped; `ftp://` rejected; trailing slash removed |
| `trigram.pg-compat` | `trigrams('cat')` equals the four trigrams the Postgres docs list; `similarity('word','two words')` matches a recorded pg fixture; punctuation splits words |
| `names.person` | `"Dr. Anna Berger"` equals `"berger anna"`; `"Berger, Anna"` equals `"Anna Berger"`; `"Anna-Marie O'Brien"` folds stably; `"Anna Berger Jr."` equals `"Anna Berger"` |
| `names.organization` | `"Northstar Ventures GmbH"` equals `"northstar ventures"`; `"The Stripe Inc."` equals `"stripe"`; word order **not** sorted |
| `duplicates.identifier-first` | when an email matches, `usedFallback` is false and `nameCandidates` is never consulted (assert by passing a poisoned candidate list) |
| `duplicates.per-kind-confidence` | one test per row of the identifier table, including **website on a contact contributes nothing** |
| `duplicates.noisy-or` | email + mobile gives 0.998; three hits stay <= 0.995 |
| `duplicates.rule-table` | one test per fallback rule, asserting rule id, confidence and evidence string |
| `duplicates.same-name-different-org` | 0.30, `best === null`, not surfaced |
| `duplicates.ordering` | matches sorted by confidence desc, capped at 5 |
| `duplicates.idempotent-reimport` | the LinkedIn fixture matched against records created from that same fixture yields `certain` for every row (this is 6.8's idempotency requirement, expressed as a pure test) |

---

## 9. Follow-ups: recurrence

### 9.1 The model

```ts
// followups/recurrence.ts
export type Recurrence =
  | { readonly kind: 'weekly' }
  | { readonly kind: 'monthly' }
  | { readonly kind: 'yearly' }
  | { readonly kind: 'every_n_days';   readonly n: number }   // 1..365
  | { readonly kind: 'every_n_months'; readonly n: number };  // 1..60

export interface RecurrenceState {
  readonly rule: Recurrence;
  /** The FIRST due date of the series. Copied unchanged into every successor. */
  readonly anchor: CivilDate;
}

export function canonicalizeRecurrence(r: Recurrence): Recurrence;
export function nextOccurrence(state: RecurrenceState, ctx: { dueAt: CivilDate; today: CivilDate }): Result<CivilDate>;
export function occurrencesBetween(state: RecurrenceState, from: CivilDate, to: CivilDate, max?: number): readonly CivilDate[];
export function snooze(dueAt: CivilDate, preset: '1d' | '1w' | '1m' | { readonly date: CivilDate }, today: CivilDate): CivilDate;
export function describeRecurrence(r: Recurrence): string;   // "Every 3 months" - the chip label
```

The brief says "every N months" in 4.1 and "custom every N days" in 6.4. Both exist. `canonicalize`
collapses the aliases so the chip label and equality are stable: `every_n_days` with `n = 7` becomes
`weekly`, `every_n_months` with `n = 1` becomes `monthly` and with `n = 12` becomes `yearly`.

**Rejected: `rrule@2.8.1`.** See section 1.2. The persisted shape is a tagged object, so
`{ kind: 'rrule', rrule: string }` is an additive variant if a real calendar rule is ever needed.

### 9.2 Two semantics that must be decided, not discovered

**(a) The next occurrence is computed from the DUE DATE, not the completion date, and then rolled
forward past today.**

A quarterly follow-up due 15 January, ticked off on 20 June, produces 15 October - not 20 September
(completion-anchored, which lets the cadence drift), and not 15 April (due-anchored without
roll-forward, which creates an instantly-overdue follow-up and, if repeated, a backlog of ghosts).

- Rejected alternative - **completion-anchored**: right for habits ("water the plants every 3 days"),
  wrong for relationships ("check in with Anna each quarter"), and it silently converts a monthly
  cadence into a five-weekly one for anyone who is ever a few days late.
- Explanation for Simon, one sentence: *a repeating reminder always lands on the same day of the
  month, even if you were late - and you never get two overdue copies of the same reminder.*

**(b) Month arithmetic is anchored on the SERIES' first due date, not the previous one.**

`anchor = 2026-01-31`, monthly:

```
2026-01-31 -> 2026-02-28 -> 2026-03-31 -> 2026-04-30 -> 2026-05-31
```

Clamping from the *previous* date instead would give `01-31 -> 02-28 -> 03-28 -> 04-28`: one February
permanently demotes the series to the 28th. Same mechanism for `yearly` on 29 February:
`2024-02-29 -> 2025-02-28 -> 2026-02-28 -> 2027-02-28 -> 2028-02-29`.

This is why `RecurrenceState` carries `anchor` and why the stored `recurrence` jsonb gains an `anchor`
key - copied verbatim into each successor follow-up so a chain that runs for years never drifts.

### 9.3 Follow-up state

```ts
// followups/state.ts
export type FollowUpState = 'done' | 'snoozed' | 'overdue' | 'due_today' | 'upcoming';
export function followUpState(f: { status: 'Open'|'Done'|'Snoozed'; dueAt: CivilDate }, today: CivilDate): FollowUpState;
```

One function, used by the dashboard's "Needs your attention" list (6.1), the red due-date styling in the
Follow-ups table (6.4) and the `open_followups` / `next_followup_at` metric computation. Three call
sites, one definition of "overdue" - otherwise the dashboard and the table disagree at midnight.

### 9.4 Unit tests - recurrence

| Test | Assertion |
|---|---|
| `canonicalize` | `every_n_days:7` gives `weekly`; `every_n_months:1` gives `monthly`; `every_n_months:12` gives `yearly`; `every_n_days:30` stays as-is (a month is not 30 days) |
| `next.weekly` | due 2026-03-02, completed 2026-03-02, today 2026-03-02, gives 2026-03-09 |
| `next.late` | due 2026-01-15, quarterly, today 2026-06-20, gives 2026-10-15 (skips the missed occurrence) |
| `next.early` | due 2026-03-20, monthly, today 2026-03-01, gives 2026-04-20 |
| `next.month-end-chain` | anchor 2026-01-31 monthly gives the exact five-date sequence above |
| `next.leap-year-chain` | anchor 2024-02-29 yearly gives the exact four-date sequence above |
| `next.every_n_days` | `n = 45`, due 2026-01-01, today 2026-05-01, gives 2026-05-16 (computed by division, not a loop) |
| `next.dst-irrelevant` | crossing a DST boundary changes nothing (civil dates carry no time) |
| `next.no-infinite-loop` | `n = 1` day, due 10 years ago, returns in bounded time and gives tomorrow |
| `occurrencesBetween` | 12 monthly occurrences across a year boundary; `max` respected |
| `snooze` | `1d`, `1w`, `1m` from a month end; explicit date in the past gives `bad_date` |
| `describe` | every variant produces the chip label the brief's 6.4 dropdown uses |
| `state.boundaries` | due yesterday gives `overdue`, due today gives `due_today`, due tomorrow gives `upcoming`; `Done` and `Snoozed` win over the date |

---

## 10. Import: mapping, presets, header synonyms

### 10.1 Where the line is

Core owns **decisions**; `packages/import` owns **bytes**. Core never sees a file, a stream or a
`Buffer`. It is handed `RawRow = Readonly<Record<string, string>>` plus column metadata, and returns
mappings, coerced values and issues. This is what lets the whole import brain be tested with plain
arrays - which matters, because 6.8 is the single biggest source of silent data damage in the product.

```ts
export interface SourceColumn {
  readonly index: number;          // 0-based
  readonly letter: string;         // "A", "B", ... - the reference screenshot shows column letters
  readonly header: string;
  readonly samples: readonly string[];   // up to 200 non-empty values, for inference
  readonly filledRatio: number;    // 6.8's "% of rows have a value"
}
```

### 10.2 Auto-mapping

```ts
// import/automap.ts
export type MappingReason = 'preset' | 'slug' | 'title' | 'synonym' | 'normalized' | 'fuzzy' | 'none' | 'target_taken';

export type MappingTarget =
  | { readonly kind: 'field'; readonly slug: string }
  | { readonly kind: 'link';  readonly slug: string; readonly part: 'title' | 'from' | 'to' }  // 4.3 link metadata
  | { readonly kind: 'skip' };

export interface ColumnMapping {
  readonly sourceIndex: number;
  readonly target: MappingTarget;
  readonly confidence: number;
  readonly reason: MappingReason;
  readonly dateFormat?: DateFormat;                    // inferred, editable
  readonly valueMapping?: readonly ValueMappingRow[];  // select / tags targets only
  readonly multiValueSeparator?: string;
}

export function autoMapColumns(
  columns: readonly SourceColumn[],
  fields: readonly FieldDescriptor[],
  opts?: { readonly preset?: ImportPreset },
): readonly ColumnMapping[];
```

The cascade, first hit wins, each step recording its own `reason` and `confidence` so the wizard can
render 6.8's three states ("Auto-mapped to EMAIL" with a green check / "Not mapped - will be skipped" /
a warning):

| # | Rule | Confidence | Reason |
|---|---|---|---|
| 1 | the active preset names this exact source header | 1.00 | `preset` |
| 2 | `normalizeText(header)` equals a field slug (underscores treated as spaces) | 1.00 | `slug` |
| 3 | `normalizeText(header)` equals `normalizeText(field.label)` | 0.98 | `title` |
| 4 | the synonym table matches (string or regex) | 0.95 | `synonym` | 
| 5 | equality after removing all non-alphanumerics ("E-Mail Address" vs "emailaddress") | 0.90 | `normalized` |
| 6 | `trigramSimilarity(header, label or slug) >= 0.72` | 0.60-0.85 | `fuzzy` |
| 7 | nothing | 0 | `none` |

**One target, one column.** After the cascade, if two columns claim the same target, the higher
confidence keeps it and the loser becomes `{ kind: 'skip' }` with reason `target_taken`. Without this
rule a Google export with both `E-mail 1 - Value` and `E-mail 2 - Value` would silently map two columns
onto one single-valued attribute and the last writer would win at row level - a data-loss bug that
looks like a mapping bug. (The correct handling for the second email column is a user choice in the
wizard, which is exactly why it must be surfaced rather than resolved silently.)

**Only rules 1-5 auto-confirm.** `fuzzy` renders as a *suggestion* the user has to accept, because a
60-85 % header guess that maps `Notes` onto `Note type` is the kind of thing nobody notices until the
data is in.

### 10.3 The synonym table

```ts
// import/synonyms.ts
export interface SynonymRule {
  readonly match: string | RegExp;   // strings are compared after normalizeText
  readonly slug: string;
  readonly confidence?: number;      // default 0.95
  readonly objectTypes?: readonly ObjectType[];
}

export const SYNONYMS: readonly SynonymRule[] = [
  // email
  { match: 'e mail', slug: 'email' }, { match: 'email address', slug: 'email' },
  { match: 'e mail address', slug: 'email' }, { match: 'mail', slug: 'email' },
  { match: 'e mail adresse', slug: 'email' }, { match: 'primary email', slug: 'email' },
  { match: /^e-?mail \d+ - value$/, slug: 'email' },              // Google Contacts
  // name
  { match: 'given name', slug: 'first_name' }, { match: 'forename', slug: 'first_name' },
  { match: 'vorname', slug: 'first_name' }, { match: 'first', slug: 'first_name' },
  { match: 'surname', slug: 'last_name' },  { match: 'family name', slug: 'last_name' },
  { match: 'nachname', slug: 'last_name' }, { match: 'last', slug: 'last_name' },
  // organization + title
  { match: 'company', slug: 'organization' }, { match: 'company name', slug: 'organization' },
  { match: 'current company', slug: 'organization' }, { match: 'employer', slug: 'organization' },
  { match: 'organisation', slug: 'organization' }, { match: 'firma', slug: 'organization' },
  { match: /^organization \d+ - name$/, slug: 'organization' },   // Google Contacts
  { match: 'position', slug: 'organization', confidence: 0.9 },   // maps to the LINK title, see presets
  { match: 'job title', slug: 'job_role' }, { match: 'role', slug: 'job_role' },
  { match: 'titel', slug: 'job_role' },
  // phone
  { match: 'phone number', slug: 'phone' }, { match: 'mobile', slug: 'phone' },
  { match: 'mobile phone', slug: 'phone' }, { match: 'telephone', slug: 'phone' },
  { match: 'telefon', slug: 'phone' }, { match: 'handy', slug: 'phone' },
  { match: /^phone \d+ - value$/, slug: 'phone' },                // Google Contacts
  // web
  { match: 'linkedin', slug: 'linkedin_url' }, { match: 'profile url', slug: 'linkedin_url' },
  { match: 'linkedin profile', slug: 'linkedin_url' }, { match: 'url', slug: 'linkedin_url', confidence: 0.7 },
  { match: 'website', slug: 'website' }, { match: 'homepage', slug: 'website' },
  { match: 'webseite', slug: 'website' }, { match: 'web', slug: 'website', confidence: 0.75 },
  // place
  { match: 'town', slug: 'city' }, { match: 'stadt', slug: 'city' }, { match: 'ort', slug: 'city' },
  { match: 'land', slug: 'country' }, { match: 'country region', slug: 'country' },
  // misc
  { match: 'birthday', slug: 'birthday' }, { match: 'geburtstag', slug: 'birthday' },
  { match: 'date of birth', slug: 'birthday' }, { match: 'dob', slug: 'birthday' },
  { match: 'labels', slug: 'areas_of_interest', confidence: 0.6 },
  { match: 'tags', slug: 'areas_of_interest', confidence: 0.7 },
  { match: 'notes', slug: 'notes' }, { match: 'notiz', slug: 'notes' },
];
```

Two notes. First, **`url` maps to `linkedin_url` at only 0.7** - it is the LinkedIn export's header, but
in a generic CSV it usually means a website; below the auto-confirm bar, so the user decides. Second,
German is included because both users are German and their Outlook/Excel exports will be. The table is
data, so adding a language is a pull request with no code.

**Rejected: LLM-based header mapping.** Tempting, and wrong here. The brief's rule is "the LLM
extracts; code decides", the mapping step is deterministic and cheap, and an LLM mapping is
unreproducible across runs of the same file - which breaks 6.8's idempotency requirement. The
sensible future use is the opposite direction: let the LLM *propose* names for unmapped columns when
the user clicks "Create new attribute", which is a suggestion the user confirms.

### 10.4 Presets

```ts
// import/presets/index.ts
export interface ImportPreset {
  readonly id: 'generic' | 'linkedin_connections' | 'google_contacts' | 'vcard';
  readonly label: string;
  readonly objectTypes: readonly ObjectType[];
  /** 0..1 - how confident we are this file IS this format, from its headers. */
  detect(headers: readonly string[]): number;
  /** Rows to skip before the header row. LinkedIn's export has a 3-line "Notes:" preamble. */
  headerRowIndex?(firstLines: readonly string[]): number;
  readonly columns: Readonly<Record<string, MappingTarget & { readonly dateFormat?: DateFormat }>>;
  readonly multiValueSeparator?: string;
}
```

**`linkedin_connections`** - the format Simon will actually use on day one:

| source header | target |
|---|---|
| `First Name` | `first_name` |
| `Last Name` | `last_name` |
| `URL` | `linkedin_url` |
| `Email Address` | `email` |
| `Company` | `organization` (relation; create the Organization if the name is new) |
| `Position` | `organization` link `title` |
| `Connected On` | `organization` link `from`, `dateFormat: 'dd_mon_yyyy'` |

Two traps the preset encodes, both worth the file on their own:
- **The preamble.** LinkedIn's `Connections.csv` begins with three "Notes:" lines before the real
  header row. A naive parse produces one column called `Notes:` and zero mapped fields.
  `headerRowIndex` finds the first line containing `First Name`.
- **`Connected On` is `21 Feb 2024`**, not ISO and not numeric - so the preset pins the format rather
  than leaving it to inference.

**`google_contacts`** covers both the current and the older export shapes
(`Given Name` / `Family Name` / `E-mail 1 - Value` / `Phone 1 - Value` /
`Organization 1 - Name` / `Organization 1 - Title` / `Labels`) and sets
`multiValueSeparator: ' ::: '`, which is what Google puts between multiple values in one cell.

**`vcard`** is a mapping table only (`FN`, `N`, `EMAIL`, `TEL`, `ORG`, `TITLE`, `URL`, `BDAY`, `ADR`,
`NOTE`, `CATEGORIES`); the `.vcf` parser lives in `packages/import` (line unfolding, quoted-printable,
v2.1 vs v4.0) because it is a byte-level format parser, not a domain decision.

### 10.5 Date-format inference

```ts
// import/date-format.ts
export type DateFormat = 'iso' | 'dmy' | 'mdy' | 'dd_mon_yyyy' | 'ymd_slash';
export function inferDateFormat(samples: readonly string[]):
  { readonly format: DateFormat | null; readonly ambiguous: boolean; readonly conflicting: boolean };
export function parseDateWithFormat(raw: string, format: DateFormat): Result<CivilDate>;
```

Scan **every** sample, not the first: if any first component exceeds 12 it is day-first; if any second
component exceeds 12 it is month-first; if both occur the column is `conflicting` (mixed data, an
error the user must see); if neither occurs the column is `ambiguous` and the wizard shows a small
`DD/MM` / `MM/DD` toggle on the mapping card, defaulting to `dmy`.

**Rejected: accept ISO only and error on everything else.** `03/04/2025` is what real exports contain,
and guessing wrong silently shifts a birthday by nine months. Inference plus an explicit toggle when
inference cannot decide is the honest middle.

### 10.6 Value mapping and row validation

```ts
// import/value-mapping.ts
export interface ValueMappingRow {
  readonly sourceValue: string;
  readonly count: number;
  readonly action: { readonly kind: 'map'; readonly optionKey: string }
                 | { readonly kind: 'create'; readonly label: string; readonly key: string }
                 | { readonly kind: 'ignore' };
  readonly confidence: number;
}
export function proposeValueMapping(
  distinct: readonly { readonly value: string; readonly count: number }[],
  options: readonly AttributeOption[],
): readonly ValueMappingRow[];

// import/validate.ts
export interface PreparedValue { readonly slug: string; readonly slot: SlotValue; readonly valueKey: string }
export function validateRow(
  raw: RawRow,
  mappings: readonly ColumnMapping[],
  fields: FieldResolver,
  ctx: TypeContext,
): { readonly values: readonly PreparedValue[]; readonly issues: readonly CoreIssue[] };
```

`proposeValueMapping` uses the same cascade as everything else: exact option key, exact label, folded
label, `trigramSimilarity >= 0.80`, otherwise a `create` proposal whose `key` is `suggestSlug(label)` -
so option keys created by an import obey the same rules as ones created in Settings.

`validateRow` calls each type's `coerce`, so **there is no second parser for CSV values**: the same
function that validates an inline table edit validates an imported cell, and a fix in one is a fix in
both. Its `issues` carry `path: [slug]`, which is exactly what 6.8's error grid needs to highlight a
cell.

**Idempotency is composition, not new code.** The importer builds a `DuplicateInput` from the prepared
values and calls `matchDuplicates` (section 8.4). Re-importing the same LinkedIn export therefore
produces `certain` matches on `linkedin_url` for every row, and the user's `Skip` or `Merge` choice is
honoured - which is 6.8's "must be idempotent enough" requirement, discharged by reusing one function.

### 10.7 Unit tests - import

| Group | Tests |
|---|---|
| `automap.cascade` | one test per rule 1-7, asserting `reason` and `confidence` |
| `automap.linkedin` | the exact LinkedIn header row maps all seven columns, including `Position` to the link title and `Connected On` to the link `from` |
| `automap.google` | both Google header generations map; `E-mail 2 - Value` becomes `target_taken`, not a silent overwrite |
| `automap.german` | `Vorname`, `Nachname`, `E-Mail-Adresse`, `Firma`, `Telefon`, `Ort` all map |
| `automap.conflict` | two columns claiming `email`: higher confidence wins, the other is skipped with `target_taken` |
| `automap.fuzzy-not-auto` | a 0.75 fuzzy hit is returned as a suggestion, not as a confirmed mapping |
| `automap.no-false-positive` | a column called `Notes:` (the LinkedIn preamble artefact) maps to nothing |
| `preset.detect` | LinkedIn headers score > 0.9 for `linkedin_connections` and < 0.3 for `google_contacts`, and vice versa |
| `preset.preamble` | a fixture with the three "Notes:" lines yields `headerRowIndex === 3` |
| `dateformat.infer` | `["01/02/2025","13/02/2025"]` gives `dmy`; `["01/02/2025","01/13/2025"]` gives `mdy`; `["01/02/2025","02/01/2025"]` gives ambiguous; `["13/02/2025","01/13/2025"]` gives conflicting; `["21 Feb 2024"]` gives `dd_mon_yyyy` |
| `dateformat.parse` | each format round-trips to the right `CivilDate`; `31/02/2025` gives `bad_date` |
| `valuemapping.cascade` | exact key, exact label, folded label, trigram, and a `create` proposal whose key passes `validateSlug` |
| `validateRow.issues` | required missing, invalid email, unknown option, bad date, too long - each with `path: [slug]` and the right code |
| `validateRow.multivalue` | ` ::: ` splitting for Google; comma splitting for tags; empty parts dropped |
| `validateRow.uses-type-coerce` | property test: for 500 random cells, `validateRow` and a direct `typeDef(t).coerce` agree |
| `import.idempotent` | the 200-row LinkedIn fixture, mapped and validated twice, produces identical `PreparedValue`s and `certain` duplicate verdicts on the second pass |

---

## 11. Verified vs assumed

**Verified** (checked during this pass, on 2026-09-03):

- npm registry `latest`: `zod@4.5.4`, `libphonenumber-js@1.13.12`, `rrule@2.8.1`, `tldts@7.4.11`,
  `vitest@4.1.11`, `typescript@7.0.2`.
- **Zod 4**: string formats are top-level functions (`z.email()`, `z.url()`, `z.uuid()`, `z.iso.date()`,
  `z.iso.datetime()`); the chained `z.string().email()` forms are deprecated. The `message` parameter is
  replaced by `error`; `invalid_type_error` / `required_error` are removed. `.refine()` type predicates
  no longer narrow, and `ctx.path` is gone from refinement contexts. `z.record()` requires two
  arguments. `z.discriminatedUnion` supports more member schema types and composes (a discriminated
  union can be a member of another). `z.toJSONSchema()` is first-party, takes a `target`
  (`draft-2020-12` default, `draft-07`, `draft-04`, `openapi-3.0`) and pulls metadata from
  `z.globalRegistry` / `.meta()`; `z.fromJSONSchema()` exists for the reverse.
- **TypeScript 7.0** (released 2026-07-08) is a Go port that preserves type-checking semantics; the
  removals are in JS/JSDoc inference (`@enum`, `@constructor`), not in the type system. `enum` and
  `namespace` remain language features - we avoid them by policy (`erasableSyntaxOnly`), not necessity.
- **Node 24.20.0** (this machine, and the pinned runtime) has **no global `Temporal`** - it exists only
  behind `--harmony-temporal`. `Temporal` is enabled by default from Node 26. Confirmed by running
  `node -e "'Temporal' in globalThis"` here.
- **`libphonenumber-js`**: `parsePhoneNumber` (default export), `parsePhoneNumberFromString` (named,
  not deprecated) and `parsePhoneNumberWithError` (throws `ParseError`); `.number` is the E.164 string,
  `.format('E.164')` is equivalent; entry points `libphonenumber-js` / `/min` (~80 kB),
  `/max` (~145 kB, adds validation and type detection), `/mobile` (~95 kB), `/core`.
- **`pg_trgm`** (Postgres 16 docs): non-alphanumerics are ignored when extracting trigrams; each word
  is treated as having two spaces prefixed and one suffixed (`cat` gives `{"  c", " ca", "cat", "at "}`);
  similarity is measured by counting shared trigrams; comparisons are case-insensitive in a default
  build; `pg_trgm.similarity_threshold` defaults to 0.3 and drives the `%` operator.
- **Postgres `unaccent`**'s default rules are generated with CLDR Latin-ASCII **including ligature
  expansion** (the docs give "Æ to AE"), which is the basis of the divergence argument in section 2.4.
- **Vitest 4** breaking changes are configuration-level (`poolOptions` removed, `maxThreads`/`maxForks`
  replaced by `maxWorkers`, `workspace` renamed to `projects`, coverage providers are separate
  packages, module mocking reworked). Nothing in a pure unit-test suite is affected.

**Assumed, with the test that will prove it:**

- **`pg_trgm`'s similarity denominator is the trigram-set union** (Jaccard). The documentation states
  the range and "counting shared trigrams" but not the formula. Pinned by a Stage-1 integration test
  comparing `trigramSimilarity` with `SELECT similarity($1,$2)` over 100 pairs.
- **`normalizeText` and any residual SQL-side folding agree.** Under the section 2.4 decision there is
  no SQL-side folding at all, which is the point; a Stage-1 CI check nonetheless asserts that every
  `attribute_value.text_norm` in the seeded database equals `normalizeText(text_value)` recomputed in
  TypeScript.
- **`z.enum(...)` accepts a runtime-built option-key array** in Zod 4 with an acceptable error message
  for the select types. If the ergonomics are poor, the fallback is
  `z.string().refine(k => keys.has(k))` with a hand-written message - a one-line change confined to two
  type files.
- **Bundle impact of `libphonenumber-js/max` on `apps/web` is zero** because it sits behind the
  `@mutuals/core/phone` subpath. Verified in Stage 2 by a bundle-size assertion in CI.
- **`Intl.DateTimeFormat.formatToParts` with an IANA `timeZone` is available and correct** on Node 24
  and in every browser we target (Node 24 ships full ICU). One unit test for `todayIn` across
  `Europe/Berlin`, `America/Los_Angeles` and `Pacific/Kiritimati` at UTC midnight.
- **Every latency claim is inherited from `storage-DECISION.md` and is still an extrapolation.** Nothing
  in this document adds a measurement.

---

## 12. Stage-1 definition of done for `packages/core`

1. All twelve attribute types implemented as registry files; `registry.matches-brief-table` green.
2. The architecture test (`no file outside `attributes/slots.ts` names a physical value column`) is in
   CI and green.
3. The filter compiler has **at least 60 unit tests**, including the injection property test and the
   identifier-allowlist property test, and every golden SQL string is asserted inline.
4. `computeWarmth` passes the calibration table, including `k = ln 4 / 10.4449079`.
5. `matchDuplicates` passes one test per identifier kind and one per fallback rule, and the
   "identifiers first, never names first" test poisons the name candidate list to prove it.
6. Recurrence passes the 31-January chain and the 29-February chain.
7. The LinkedIn and Google Contacts fixtures from the brief's 8.1 map end-to-end through
   `autoMapColumns` + `validateRow` with zero unmapped known columns.
8. `packages/core` has **no `import` of anything outside `zod`, `libphonenumber-js` and itself** -
   asserted by a dependency-cruiser style test, so purity is a build failure and not a convention.
9. Coverage on `packages/core` is at least 90 % lines / 85 % branches, enforced in CI. (This is the one
   package where a coverage gate earns its keep: it is pure, so a gap is a real untested branch, not an
   untestable integration seam.)
10. `docs/ARCHITECTURE.md` contains the type-registry diagram and the sentence "adding an attribute type
    is one file plus one array entry plus one `ALTER TYPE`".

---

## 13. ADRs to write into `docs/DECISIONS.md`

1. `packages/core` is pure, clock-free and returns `Result`; `now`/`today` are always parameters.
2. Dependency budget: `zod@4.5.4` and `libphonenumber-js@1.13.12` only; dates, slugs, recurrence,
   similarity and public-suffix handling are hand-written.
3. Attribute types are a data-driven registry; `AttributeType` is derived from it; physical column
   names live in one file, enforced by a CI grep test.
4. Canonical value forms: decimal strings for numbers, `YYYY-MM-DD` civil strings for dates.
5. **Text normalisation lives only in TypeScript**; `fact` carries `text_norm`/`text_sort`; the SQL
   projector copies them; the `unaccent` extension is dropped. (Amends `storage-DECISION` sections 2.4,
   2.5 and 4.5.)
6. The filter model is a discriminated union on the operator; payloads are strings; the field decides
   interpretation.
7. Relative date filters are stored relative and resolved at compile time, so saved views do not freeze.
8. Filters serialise as repeated compact `filter=field:op:value` query parameters, not as one JSON blob.
9. The compiler emits Postgres SQL text and parameters from `packages/core`; no IR, no ORM objects.
10. Three-tier reserved-slug list, with the system tier derived from the field registry.
11. Warmth `k = 0.13273534`, calibrated at the moment of a monthly meeting; whole-day decay; cap beats
    floor when both override flags are set.
12. Duplicate matching: per-kind identifier confidences combined noisy-or, a website is not identity for
    a person, and the name fallback is an ordered rule table rather than a weighted score.
13. `emailMatchKey` (gmail dots, plus-tags) is a duplicate signal only, never a stored identifier.
14. Website identity is host-based, with no public-suffix dependency.
15. Recurrence is a closed five-variant union; the next occurrence is computed from the due date, rolled
    forward past today, with month arithmetic anchored on the series' first due date.
16. `profile.phone_region` is added (default `DE`) so national-format phone numbers can be normalised.
17. Import auto-mapping is a deterministic seven-step cascade with per-target exclusivity; only steps
    1-5 auto-confirm; the LLM is not used for column mapping.
18. Import date formats are inferred per column from all samples, with an explicit user toggle when
    inference is ambiguous.

---

## 14. Open questions for humans

Only three. Everything else in this document is a decision, logged as an ADR, reversible if wrong.

**Q1 - For Simon (product). Does "No interaction in 90 days" include people you have never contacted?**

The brief seeds that view on the Contacts page (6.2). "Last interaction more than 90 days ago" and
"never interacted at all" are different statements, and the compiler must pick one.

- **(a) Exclude never-contacted (recommended).** The view means "people who have gone quiet". A
  second seeded view, `Never contacted`, covers the other group and is arguably the more actionable
  list of the two.
- (b) Include them - one list of everyone who needs attention, at the cost of a freshly imported
  10 000-row LinkedIn export filling the view on day one.
- (c) Make it a per-filter toggle on the chip. Rejected in the design as it breaks the
  arity-in-the-types rule and needs an `OR` in the filter model, which is AND-only.

**Q2 - For Simon (product). In the import review grid, what is pre-selected for a near-certain
duplicate (same email or same LinkedIn URL)?**

- **(a) Pre-select `Skip` (recommended).** Re-importing the same export becomes a no-op, which is
  exactly what 6.8 asks for, and nothing is ever silently overwritten.
- (b) Pre-select `Merge into existing` (fill empty fields only). Better for enrichment - re-importing a
  newer LinkedIn export fills in job changes - but it writes to existing records from a bulk action
  the user may have clicked through.
- (c) Pre-select nothing; force a choice per row or one bulk choice. Safest, slowest.

**Q3 - For the co-founder (architecture). Two schema additions this design needs, both amending the
accepted storage decision.**

1. **`fact.text_norm` and `fact.text_sort` written by the application; the projector copies them; the
   `unaccent` extension is dropped** (section 2.4). Without it, Postgres `unaccent()` and the
   TypeScript fold disagree on `ß`, `æ`, `ø`, `ł` and a filter for "Straßburg" silently returns
   nothing. Cost: about +8 MB at the 10 k-contact sizing, and a `CHECK` that makes a hand-written
   `INSERT INTO fact` fail loudly instead of producing an unfindable row. The alternative - generating
   an `IMMUTABLE mutuals_norm()` SQL function from the same fold table - is written up in section 2.4
   and is a reasonable second choice.
2. **`contact.name_key text`** written by the application, with a btree index and a trigram GIN
   (section 8.2), so duplicate candidate generation probes the same normalised form core scores
   against. Without it, candidate recall silently drops for accented names, and the workaround is a
   double probe per lookup.

Both are additive migrations. Neither changes the read path, the API or the UI. Confirm, or say which
you would rather not have and I will take the documented fallback.
