/**
 * ADR-044's step 4: the synonym table.
 *
 * It exists because the two mappings the import most needs share no trigram with their target —
 * `similarity('company','organization')` and `similarity('position','job role')` are both exactly
 * 0.0, measured, so no threshold reaches them (`header.test.ts` pins that). Steps 1, 2, 5 and 6 are
 * all string-shape rules; this is the only step that encodes meaning, which is why it is a table a
 * person maintains rather than an algorithm.
 *
 * German entries are here because both users write German. Keys are already normalised.
 * Values name target ids, and a value naming a field this workspace does not have contributes
 * nothing — the cascade resolves every proposal against the live target list.
 */
export const HEADER_SYNONYMS: Readonly<Record<string, string>> = {
  // -- names ------------------------------------------------------------------------------------
  'given name': 'first_name',
  forename: 'first_name',
  'christian name': 'first_name',
  vorname: 'first_name',
  surname: 'last_name',
  'family name': 'last_name',
  nachname: 'last_name',
  familienname: 'last_name',
  'full name': 'first_name',

  // -- reachability -----------------------------------------------------------------------------
  'e mail': 'email',
  mail: 'email',
  'email address': 'email',
  'e mail address': 'email',
  'mail address': 'email',
  emailadresse: 'email',
  telephone: 'phone',
  tel: 'phone',
  'phone number': 'phone',
  mobile: 'phone',
  'mobile number': 'phone',
  cell: 'phone',
  'cell phone': 'phone',
  telefon: 'phone',
  telefonnummer: 'phone',
  handy: 'phone',

  // -- where they work --------------------------------------------------------------------------
  company: 'organization',
  'company name': 'organization',
  organisation: 'organization',
  employer: 'organization',
  firm: 'organization',
  firma: 'organization',
  unternehmen: 'organization',
  arbeitgeber: 'organization',
  position: 'organization.title',
  'job title': 'organization.title',
  jobtitle: 'organization.title',
  role: 'organization.title',
  designation: 'organization.title',
  berufsbezeichnung: 'organization.title',

  // -- where they are ---------------------------------------------------------------------------
  town: 'city',
  ort: 'city',
  stadt: 'city',
  wohnort: 'city',
  land: 'country',

  // -- the rest ---------------------------------------------------------------------------------
  'birth date': 'birthday',
  birthdate: 'birthday',
  'date of birth': 'birthday',
  dob: 'birthday',
  geburtstag: 'birthday',
  geburtsdatum: 'birthday',
  linkedin: 'linkedin_url',
  'linkedin profile': 'linkedin_url',
  'linkedin url': 'linkedin_url',
  'web site': 'website',
  homepage: 'website',
  webseite: 'website',
  note: 'notes',
  comment: 'notes',
  comments: 'notes',
  bemerkung: 'notes',
  notizen: 'notes',
  interests: 'areas_of_interest',
  interessen: 'areas_of_interest',
}
