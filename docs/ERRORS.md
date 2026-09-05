# Error codes

Every error the API returns is [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `problem+json`, and
its `type` is a link into this file. So every anchor here has to exist: a `type` that 404s is worse
than no link at all. `apps/api` has a test asserting that every code in `ALL_ERROR_CODES` has a
heading below.

The shape:

```json
{
  "type": "https://github.com/Kyrillus/mutuals/blob/main/docs/ERRORS.md#validation_failed",
  "title": "The request could not be accepted",
  "status": 400,
  "detail": "There is no field called \"no_such_field\".",
  "instance": "/api/v1/contacts?filter=…",
  "errors": [
    { "field": "filter.0.field", "code": "unknown_field", "message": "There is no field called …" }
  ]
}
```

`title` is stable per `type` and safe to match on. `detail` is written for a person and may change.
`errors` carries one entry per offending field, which is what a form needs to mark the right input.

---

## Transport codes

These are the `type` of the response itself.

### validation_failed

**400.** The request was understood and rejected. Every specific reason is in `errors[]`, each with
one of the field codes below. This is the only 4xx that always carries `errors[]`.

### not_found

**404.** No record, attribute definition, view or import batch with that id in this workspace. It does
not distinguish "never existed" from "deleted", because deletion is real and irreversible (ADR-016).

### conflict

**409.** The write collided with a rule that only the database can check. In practice: a duplicate
attribute slug, or an attempt to change an attribute's type while values exist — which the composite
foreign key refuses, because §4.2 says type changes are not supported.

### unsupported_media_type

**415.** The endpoint wanted `application/json` (or, for an import upload, `multipart/form-data`) and
got something else.

### payload_too_large

**413.** Above the configured body limit. Import files go through the upload endpoint, which streams;
they do not count against this.

### not_implemented

**501.** The route is documented in the OpenAPI schema and does not do anything yet — deliberate
rather than a 404, so a client can tell "planned" apart from "wrong URL". `search`, `ask` and
`quick-capture` answered this from Stage 1 until Stage 6 built them; **no route returns it today**.
The code stays because the pattern is how this API publishes a shape before fitting the engine, and
the next planned operation will use it again.

### internal_error

**500.** A bug. `detail` is generic on purpose; the specifics are in the server log with a matching
request id.

### llm_disabled

**503.** The AI features (§4.8) cannot run here. Either `LLM_MODE=off`, or there is no
`OPENROUTER_API_KEY` — a fresh checkout has neither and the rest of the app works fine without them.
`detail` says which. This is not a failure to retry: something has to change in the configuration
first.

### llm_budget_exceeded

**429.** `LLM_DAILY_COST_LIMIT_USD` has been reached for today (ADR-070, Q7 — $5.00). A circuit
breaker rather than a budget: the same request will work after midnight in the profile's timezone,
and nothing about it was wrong. `detail` carries the limit and what has been spent. The cap is
checked immediately before **every** billable request to the model provider, including retries and
the one repair round-trip, so a loop cannot bill six generations per user action.

### llm_unavailable

**504.** The model provider did not answer: unreachable, or past `LLM_TOTAL_TIMEOUT_MS`, or
answering an error status three times. Retrying is reasonable. In `LLM_MODE=replay` this is also
what a missing fixture returns, and `detail` then carries the command that records one.

### llm_invalid_response

**502.** The model provider answered, twice, with something that is not the shape it was asked for —
once on the original request and once on the repair round-trip ADR-066 allows. The structured output
was requested with `strict: true` and `provider.require_parameters`, so this means an endpoint that
does not honour its own contract; the trace row in `llm_call` has the exact validation failures.

---

## Field codes

These appear in `errors[].code`. They never appear as a response `type`.

### required

The field is required and was missing or empty.

### invalid_input

The value does not fit the field's type and no more specific code applies.

### too_long

Above the type's length limit — 255 characters for `short_text`, 512 for a tag's key.

### out_of_range

Outside the `min`/`max` in the attribute's config.

### not_a_number

A `number` attribute got something that is not one.

### bad_date

Not a date in any format the parser accepts.

### ambiguous_date

A date that could be two real dates — `03/04/2026` is 3 April or 4 March depending on where the file
came from. The import wizard asks; nothing guesses.

### invalid_email

Not an email address.

### invalid_phone

Not a phone number, or not one that can be normalised to E.164 in the profile's phone region. A
number without a country code needs the region to be resolvable, which is why the profile carries one.

### ambiguous_national_number

A national-format number that is valid in more than one plausible reading. The user picks.

### invalid_linkedin_url

Not a LinkedIn profile, company or school URL.

### invalid_website

Not a URL with a host and a plausible top-level domain.

### unknown_option

A `single_select` or `multi_select` value that is not one of the attribute's options. The option's
stable `key` is what the API accepts, not its label — labels can be renamed, keys cannot.

### reserved_slug

The slug collides with a system attribute name or a SQL keyword. The reserved list is in
`packages/core/src/attributes/reserved.ts`.

### duplicate_slug

Another attribute on this object type already uses that slug. Slugs are immutable after creation, so
this cannot be resolved by renaming the other one.

### unknown_field

The filter, sort or column list named a field that is neither a system column, a derived column, nor
an attribute of this object type.

### operator_not_allowed

The operator is real but not allowed on that attribute's type — `greater_than` on a `yes_no`, for
example. The permitted set per type is in the brief's §4.2 table and in `OPERATORS_BY_TYPE`.

### not_sortable

Sorting was requested on a type the brief marks unsortable: `long_text`, `multi_select`, `tags`,
`url`, `phone` and `relation`. Rejected rather than ignored, so a saved view cannot quietly stop
sorting the way it says it does.

### arity_mismatch

The operator got the wrong number of values — `between` with one bound, or `is_one_of` with none.

### malformed_query

The `filter` or `sort` parameter is not the JSON the wire format expects. The format is documented in
`docs/ARCHITECTURE.md`.

### repeated_parameter

A query parameter that may appear once appeared more than once. Rejected rather than
last-one-wins, because silently dropping half a filter is how a view shows the wrong rows.

### too_many_filters

Above the per-request filter limit. The limit exists so one URL cannot build an arbitrarily large
query.
