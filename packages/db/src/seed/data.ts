/**
 * The curated half of the demo seed.
 *
 * Everything here is written by hand rather than generated, because the seed has one job the
 * random generator cannot do: be *plausible*. A founder has to work at a startup and an investor
 * at a fund, a fintech company has to be in a fintech city, and — most of all — the `asks` of one
 * person have to be the `offers` of another, because that pairing is the product's whole thesis
 * (§4.1, §9: "intro suggestions only on an ask↔offer match, never on topic similarity").
 *
 * Every organization, person and company here is fictional. Two real names survive on purpose:
 * `Bits & Pretzels` because the brief uses it as its own example, and `Stripe` inside an ask/offer
 * tag for the same reason. Neither is modelled as a record.
 */

/** The keys of the `type` options migration 0002 seeds for organizations. */
export type OrgTypeKey = 'startup' | 'vc_fund' | 'angel' | 'corporate' | 'university' | 'community'

/** The keys of the `stage` options migration 0002 seeds. */
export type StageKey = 'pre_seed' | 'seed' | 'series_a' | 'series_b_plus' | 'public' | 'n_a'

/** The keys of the contact `job_role` options migration 0002 seeds. */
export type RoleKey =
  'founder' | 'investor' | 'operator' | 'student' | 'community_builder' | 'other'

export interface Place {
  readonly city: string
  readonly country: string
}

export interface OrganizationSeed {
  readonly name: string
  readonly type: OrgTypeKey
  readonly industry: readonly string[]
  readonly place: Place
  readonly stage: StageKey
  readonly description: string
}

/**
 * The places the network lives in. Munich leads because §6.2's example filter is "Investors in
 * Munich interested in climate tech", and a filter that returns two rows demonstrates nothing.
 * `München` is spelled with the umlaut on purpose: it is what makes ADR-019's SQL-only fold
 * visible in the seeded data rather than only in a test.
 */
export const PLACES = {
  munich: { city: 'München', country: 'Germany' },
  berlin: { city: 'Berlin', country: 'Germany' },
  hamburg: { city: 'Hamburg', country: 'Germany' },
  cologne: { city: 'Köln', country: 'Germany' },
  stuttgart: { city: 'Stuttgart', country: 'Germany' },
  nuremberg: { city: 'Nürnberg', country: 'Germany' },
  vienna: { city: 'Wien', country: 'Austria' },
  zurich: { city: 'Zürich', country: 'Switzerland' },
  basel: { city: 'Basel', country: 'Switzerland' },
  amsterdam: { city: 'Amsterdam', country: 'Netherlands' },
  rotterdam: { city: 'Rotterdam', country: 'Netherlands' },
  delft: { city: 'Delft', country: 'Netherlands' },
  london: { city: 'London', country: 'United Kingdom' },
  cambridge: { city: 'Cambridge', country: 'United Kingdom' },
  paris: { city: 'Paris', country: 'France' },
  stockholm: { city: 'Stockholm', country: 'Sweden' },
  copenhagen: { city: 'København', country: 'Denmark' },
  oslo: { city: 'Oslo', country: 'Norway' },
  lisbon: { city: 'Lisboa', country: 'Portugal' },
  barcelona: { city: 'Barcelona', country: 'Spain' },
  tallinn: { city: 'Tallinn', country: 'Estonia' },
  newYork: { city: 'New York', country: 'United States' },
  sanFrancisco: { city: 'San Francisco', country: 'United States' },
} as const satisfies Record<string, Place>

const P = PLACES

/**
 * Sixty organizations: 24 startups, 14 funds, 4 angel vehicles, 6 corporates, 4 universities,
 * 8 communities. The mix is what makes the relation column interesting — a contact list where
 * everybody works at a startup has nothing to filter.
 */
export const ORGANIZATIONS: readonly OrganizationSeed[] = [
  // --- Startups -------------------------------------------------------------------------------
  {
    name: 'Aurora Grid',
    type: 'startup',
    industry: ['Climate', 'Energy'],
    place: P.berlin,
    stage: 'seed',
    description: 'Grid-scale battery orchestration for municipal utilities.',
  },
  {
    name: 'Verdant Labs',
    type: 'startup',
    industry: ['Climate', 'Agritech'],
    place: P.amsterdam,
    stage: 'series_a',
    description: 'Soil carbon measurement for arable farms, sold through cooperatives.',
  },
  {
    name: 'Helios Storage',
    type: 'startup',
    industry: ['Climate', 'Energy'],
    place: P.munich,
    stage: 'series_a',
    description: 'Long-duration thermal storage for industrial process heat.',
  },
  {
    name: 'Nimbus Health',
    type: 'startup',
    industry: ['Health'],
    place: P.berlin,
    stage: 'seed',
    description: 'Care coordination for chronic patients, reimbursed under DiGA.',
  },
  {
    name: 'Cardia Diagnostics',
    type: 'startup',
    industry: ['Health', 'Medtech'],
    place: P.zurich,
    stage: 'series_a',
    description: 'Point-of-care cardiac markers with a reader the size of a phone.',
  },
  {
    name: 'Mesa Bio',
    type: 'startup',
    industry: ['Health', 'Biotech'],
    place: P.cambridge,
    stage: 'pre_seed',
    description: 'Cell-free protein expression for small-batch enzymes.',
  },
  {
    name: 'Ledgerly',
    type: 'startup',
    industry: ['Fintech'],
    place: P.london,
    stage: 'series_b_plus',
    description: 'Multi-entity accounting for companies that outgrew a single ledger.',
  },
  {
    name: 'Kestrel Pay',
    type: 'startup',
    industry: ['Fintech', 'Payments'],
    place: P.amsterdam,
    stage: 'series_a',
    description: 'Account-to-account payments for marketplaces in the euro area.',
  },
  {
    name: 'Fjord Ledger',
    type: 'startup',
    industry: ['Fintech'],
    place: P.stockholm,
    stage: 'seed',
    description: 'Treasury tooling for Nordic mid-market exporters.',
  },
  {
    name: 'Wavelength',
    type: 'startup',
    industry: ['Developer tools'],
    place: P.berlin,
    stage: 'seed',
    description: 'Observability for event-driven systems, priced per stream.',
  },
  {
    name: 'Runbook Systems',
    type: 'startup',
    industry: ['Developer tools', 'Infrastructure'],
    place: P.london,
    stage: 'series_a',
    description: 'Incident response that writes the postmortem while you work.',
  },
  {
    name: 'Tessel',
    type: 'startup',
    industry: ['AI', 'Developer tools'],
    place: P.munich,
    stage: 'pre_seed',
    description: 'Typed data pipelines with a schema registry that refuses bad writes.',
  },
  {
    name: 'Kiln Robotics',
    type: 'startup',
    industry: ['Robotics', 'Manufacturing'],
    place: P.munich,
    stage: 'series_a',
    description: 'Bin-picking arms for foundries, sold as a leased cell.',
  },
  {
    name: 'Northbound Logistics',
    type: 'startup',
    industry: ['Logistics'],
    place: P.hamburg,
    stage: 'series_a',
    description: 'Port-side slot booking for short-sea freight forwarders.',
  },
  {
    name: 'Palet',
    type: 'startup',
    industry: ['Supply chain'],
    place: P.rotterdam,
    stage: 'seed',
    description: 'Returnable-packaging tracking for FMCG distribution.',
  },
  {
    name: 'Sable Materials',
    type: 'startup',
    industry: ['Climate', 'Materials'],
    place: P.zurich,
    stage: 'pre_seed',
    description: 'Low-clinker cement binders qualified for structural concrete.',
  },
  {
    name: 'Orchard Talent',
    type: 'startup',
    industry: ['HR tech'],
    place: P.lisbon,
    stage: 'seed',
    description: 'Structured hiring for engineering teams under fifty people.',
  },
  {
    name: 'Sirocco Mobility',
    type: 'startup',
    industry: ['Mobility'],
    place: P.paris,
    stage: 'series_a',
    description: 'Depot charging software for municipal bus fleets.',
  },
  {
    name: 'Lumen Retail',
    type: 'startup',
    industry: ['Commerce'],
    place: P.barcelona,
    stage: 'seed',
    description: 'In-store demand forecasting for grocery chains.',
  },
  {
    name: 'Halden Security',
    type: 'startup',
    industry: ['Cybersecurity'],
    place: P.oslo,
    stage: 'series_a',
    description: 'Identity posture management for Nordic public-sector tenants.',
  },
  {
    name: 'Quill',
    type: 'startup',
    industry: ['Legaltech'],
    place: P.london,
    stage: 'seed',
    description: 'Contract review for in-house teams of one.',
  },
  {
    name: 'Farrow Insurance',
    type: 'startup',
    industry: ['Insurtech'],
    place: P.munich,
    stage: 'pre_seed',
    description: 'Parametric cover for solar installers.',
  },
  {
    name: 'Basalt Compute',
    type: 'startup',
    industry: ['AI', 'Infrastructure'],
    place: P.berlin,
    stage: 'series_b_plus',
    description: 'Scheduling and billing for shared GPU clusters in Europe.',
  },
  {
    name: 'Pelago Ocean',
    type: 'startup',
    industry: ['Climate', 'Ocean'],
    place: P.lisbon,
    stage: 'pre_seed',
    description: 'Autonomous survey vessels for offshore wind cable routes.',
  },

  // --- Funds ----------------------------------------------------------------------------------
  {
    name: 'Northstar Ventures',
    type: 'vc_fund',
    industry: ['Venture capital', 'Climate'],
    place: P.munich,
    stage: 'n_a',
    description: 'Seed fund, €120m, climate and industrial software in DACH.',
  },
  {
    name: 'Kettle Capital',
    type: 'vc_fund',
    industry: ['Venture capital', 'Consumer'],
    place: P.berlin,
    stage: 'n_a',
    description: 'Pre-seed cheques of €300–800k across German-speaking Europe.',
  },
  {
    name: 'Blue Ridge Partners',
    type: 'vc_fund',
    industry: ['Venture capital', 'Fintech'],
    place: P.london,
    stage: 'n_a',
    description: 'Series A fintech, leads rounds of £5–12m.',
  },
  {
    name: 'Vireo Fund',
    type: 'vc_fund',
    industry: ['Venture capital', 'Health'],
    place: P.amsterdam,
    stage: 'n_a',
    description: 'Digital health and medtech, seed to Series A.',
  },
  {
    name: 'Alpine Seed',
    type: 'vc_fund',
    industry: ['Venture capital', 'Deeptech'],
    place: P.zurich,
    stage: 'n_a',
    description: 'Spin-out fund attached to two Swiss technical universities.',
  },
  {
    name: 'Hafen Ventures',
    type: 'vc_fund',
    industry: ['Venture capital', 'Logistics'],
    place: P.hamburg,
    stage: 'n_a',
    description: 'Logistics and maritime software, seed stage.',
  },
  {
    name: 'Meridian Growth',
    type: 'vc_fund',
    industry: ['Venture capital', 'Growth'],
    place: P.london,
    stage: 'n_a',
    description: 'Growth equity, £20m+ cheques into European B2B software.',
  },
  {
    name: 'Terra Nova Capital',
    type: 'vc_fund',
    industry: ['Venture capital', 'Climate'],
    place: P.paris,
    stage: 'n_a',
    description: 'Article 9 climate fund investing across the EU.',
  },
  {
    name: 'Bright Angle',
    type: 'vc_fund',
    industry: ['Venture capital', 'Developer tools'],
    place: P.stockholm,
    stage: 'n_a',
    description: 'Developer-first seed fund with a Nordic LP base.',
  },
  {
    name: 'Kelvin Capital',
    type: 'vc_fund',
    industry: ['Venture capital', 'Energy'],
    place: P.copenhagen,
    stage: 'n_a',
    description: 'Energy transition, from first cheque to Series B.',
  },
  {
    name: 'Ostwind Ventures',
    type: 'vc_fund',
    industry: ['Venture capital', 'Industrial'],
    place: P.vienna,
    stage: 'n_a',
    description: 'Industrial technology in CEE, seed and Series A.',
  },
  {
    name: 'Sequitur Partners',
    type: 'vc_fund',
    industry: ['Venture capital', 'AI'],
    place: P.berlin,
    stage: 'n_a',
    description: 'Applied AI, concentrated portfolio of twelve per fund.',
  },
  {
    name: 'Falcon Bay Capital',
    type: 'vc_fund',
    industry: ['Venture capital', 'Commerce'],
    place: P.lisbon,
    stage: 'n_a',
    description: 'Iberian consumer and commerce, pre-seed to seed.',
  },
  {
    name: 'Groundwork Fund',
    type: 'vc_fund',
    industry: ['Venture capital', 'Manufacturing'],
    place: P.munich,
    stage: 'n_a',
    description: 'Manufacturing software and robotics, €1–4m first cheques.',
  },

  // --- Angel vehicles ---------------------------------------------------------------------------
  {
    name: 'Isar Angels',
    type: 'angel',
    industry: ['Angel syndicate'],
    place: P.munich,
    stage: 'n_a',
    description: 'Syndicate of forty Munich operators, one deal a month.',
  },
  {
    name: 'Grachten Angels',
    type: 'angel',
    industry: ['Angel syndicate'],
    place: P.amsterdam,
    stage: 'n_a',
    description: 'Dutch angels writing €25–100k alongside institutional seed.',
  },
  {
    name: 'Baltic Angel Syndicate',
    type: 'angel',
    industry: ['Angel syndicate'],
    place: P.tallinn,
    stage: 'n_a',
    description: 'Estonian and Finnish angels, mostly software.',
  },
  {
    name: 'Steinbeis Family Office',
    type: 'angel',
    industry: ['Family office'],
    place: P.stuttgart,
    stage: 'n_a',
    description: 'Second-generation family office, direct investments in Mittelstand suppliers.',
  },

  // --- Corporates -------------------------------------------------------------------------------
  {
    name: 'Wagner Automotive Group',
    type: 'corporate',
    industry: ['Automotive', 'Manufacturing'],
    place: P.stuttgart,
    stage: 'public',
    description: 'Tier-one supplier of thermal systems, 18,000 employees.',
  },
  {
    name: 'Rheinwerk Energie',
    type: 'corporate',
    industry: ['Energy', 'Utilities'],
    place: P.cologne,
    stage: 'public',
    description: 'Regional utility running distribution grids in the Rhineland.',
  },
  {
    name: 'Bergmann Pharma',
    type: 'corporate',
    industry: ['Pharma', 'Health'],
    place: P.basel,
    stage: 'public',
    description: 'Mid-cap pharmaceutical company with a generics division.',
  },
  {
    name: 'Nordbank',
    type: 'corporate',
    industry: ['Banking', 'Finance'],
    place: P.hamburg,
    stage: 'public',
    description: 'Commercial bank serving shipping and renewables.',
  },
  {
    name: 'Kessler Logistik',
    type: 'corporate',
    industry: ['Logistics'],
    place: P.nuremberg,
    stage: 'n_a',
    description: 'Family-owned freight forwarder, 900 trucks.',
  },
  {
    name: 'Elbe Networks',
    type: 'corporate',
    industry: ['Telecommunications'],
    place: P.berlin,
    stage: 'public',
    description: 'Fibre network operator with a venture arm.',
  },

  // --- Universities -----------------------------------------------------------------------------
  {
    name: 'Isartal Technical University',
    type: 'university',
    industry: ['Research', 'Engineering'],
    place: P.munich,
    stage: 'n_a',
    description: 'Engineering university with an entrepreneurship centre.',
  },
  {
    name: 'Zuiderzee Institute of Technology',
    type: 'university',
    industry: ['Research'],
    place: P.delft,
    stage: 'n_a',
    description: 'Applied sciences institute, strong in materials and robotics.',
  },
  {
    name: 'Nordic School of Economics',
    type: 'university',
    industry: ['Research', 'Business'],
    place: P.stockholm,
    stage: 'n_a',
    description: 'Business school with an active founders alumni chapter.',
  },
  {
    name: 'Lakeside Business School',
    type: 'university',
    industry: ['Research', 'Business'],
    place: P.zurich,
    stage: 'n_a',
    description: 'Executive education and an early-stage accelerator.',
  },

  // --- Communities ------------------------------------------------------------------------------
  {
    name: 'Bits & Pretzels',
    type: 'community',
    industry: ['Events', 'Startups'],
    place: P.munich,
    stage: 'n_a',
    description: 'Founders festival held every autumn in Munich.',
  },
  {
    name: 'Munich Climate Circle',
    type: 'community',
    industry: ['Climate', 'Community'],
    place: P.munich,
    stage: 'n_a',
    description: 'Monthly dinner for climate founders and their investors.',
  },
  {
    name: 'Female Founders Berlin',
    type: 'community',
    industry: ['Community', 'Startups'],
    place: P.berlin,
    stage: 'n_a',
    description: 'Peer group and demo nights for women founding companies.',
  },
  {
    name: 'Founders Guild Europe',
    type: 'community',
    industry: ['Community'],
    place: P.london,
    stage: 'n_a',
    description: 'Invite-only network of second-time founders.',
  },
  {
    name: 'Frontend Berlin',
    type: 'community',
    industry: ['Community', 'Developer tools'],
    place: P.berlin,
    stage: 'n_a',
    description: 'Meetup of about three hundred web engineers.',
  },
  {
    name: 'Zurich Deeptech Meetup',
    type: 'community',
    industry: ['Community', 'Deeptech'],
    place: P.zurich,
    stage: 'n_a',
    description: 'Quarterly evening for spin-outs and their first hires.',
  },
  {
    name: 'Amsterdam Angels Breakfast',
    type: 'community',
    industry: ['Community', 'Angel syndicate'],
    place: P.amsterdam,
    stage: 'n_a',
    description: 'Friday breakfast where angels pitch each other deals.',
  },
  {
    name: 'Cohort Europe',
    type: 'community',
    industry: ['Community', 'Education'],
    place: P.lisbon,
    stage: 'n_a',
    description: 'Cohort-based programme for people between companies.',
  },
]

/**
 * The organization types each role can plausibly belong to. Nothing else decides who works where,
 * which is why a founder is never seeded into a university and an investor never into a startup.
 */
export const ORG_TYPES_BY_ROLE = {
  founder: ['startup'],
  investor: ['vc_fund', 'angel'],
  operator: ['startup', 'corporate'],
  student: ['university'],
  community_builder: ['community'],
  other: ['corporate', 'community', 'university'],
} as const satisfies Record<RoleKey, readonly OrgTypeKey[]>

/** How many contacts each role gets. Sums to 200. */
export const ROLE_COUNTS = {
  founder: 62,
  investor: 48,
  operator: 55,
  student: 12,
  community_builder: 15,
  other: 8,
} as const satisfies Record<RoleKey, number>

/** The link title on the contact→organization relation, by role (§4.3). */
export const JOB_TITLES = {
  founder: ['Co-Founder', 'Founder & CEO', 'Co-Founder & CTO', 'Founder', 'Co-Founder & COO'],
  investor: ['Partner', 'Principal', 'Investment Manager', 'General Partner', 'Associate'],
  operator: [
    'Head of Product',
    'VP Engineering',
    'Head of Sales',
    'Chief of Staff',
    'Head of People',
    'Staff Engineer',
    'Head of Marketing',
    'Head of Operations',
  ],
  student: ['PhD Candidate', 'Research Assistant', 'MSc Student', 'Postdoc'],
  community_builder: ['Community Lead', 'Programme Director', 'Organiser', 'Head of Community'],
  other: ['Advisor', 'Consultant', 'Board Member', 'Freelancer'],
} as const satisfies Record<RoleKey, readonly string[]>

/**
 * An organization's industry, translated into the interest its people plausibly carry.
 *
 * Without this, `areas_of_interest` is uniform noise and §6.2's own example filter — "Investors in
 * Munich interested in climate tech" — returns nothing, which is a poor advertisement for the
 * feature the whole storage design exists to serve. A climate fund's partners are interested in
 * climate. `Venture capital` and `Angel syndicate` map to nothing on purpose: the fund's *second*
 * industry tag is its thesis, and that is the one worth inheriting.
 */
export const INTEREST_BY_INDUSTRY: Readonly<Record<string, string>> = {
  Climate: 'Climate tech',
  Ocean: 'Climate tech',
  Agritech: 'Climate tech',
  Energy: 'Energy',
  Utilities: 'Energy',
  Health: 'Health tech',
  Medtech: 'Health tech',
  Pharma: 'Health tech',
  Biotech: 'Biotech',
  Fintech: 'Fintech',
  Payments: 'Fintech',
  Banking: 'Fintech',
  Finance: 'Fintech',
  Insurtech: 'Fintech',
  'Developer tools': 'Developer tools',
  Infrastructure: 'Developer tools',
  AI: 'AI',
  Deeptech: 'AI',
  Robotics: 'Robotics',
  Manufacturing: 'Manufacturing',
  Automotive: 'Manufacturing',
  Materials: 'Hardware',
  Mobility: 'Manufacturing',
  Logistics: 'Logistics',
  'Supply chain': 'Logistics',
  Commerce: 'Marketplaces',
  Consumer: 'Marketplaces',
  'HR tech': 'Education',
  Legaltech: 'Public policy',
  Cybersecurity: 'Cybersecurity',
  Telecommunications: 'Hardware',
  Community: 'Community building',
  Events: 'Community building',
  Startups: 'Community building',
  Research: 'Education',
  Engineering: 'Hardware',
  Business: 'Education',
  Education: 'Education',
}

export const AREAS_OF_INTEREST: readonly string[] = [
  'Climate tech',
  'Fintech',
  'Health tech',
  'Developer tools',
  'AI',
  'Robotics',
  'Manufacturing',
  'Logistics',
  'Marketplaces',
  'Open source',
  'Hardware',
  'Energy',
  'Biotech',
  'Cybersecurity',
  'Design',
  'Community building',
  'Public policy',
  'Education',
]

/**
 * The planted ask↔offer matches — the reason the seed exists in this shape.
 *
 * `tag` is written **identically** on both sides, because a match is an exact-value match on the
 * normalised tag key and never a similarity score (§9). `asks` is how many contacts carry it as an
 * ask, `offers` how many carry it as an offer, and the roles say who is plausible on each side.
 */
export interface AskOfferPair {
  readonly tag: string
  readonly asks: number
  readonly offers: number
  readonly askRoles: readonly RoleKey[]
  readonly offerRoles: readonly RoleKey[]
}

export const ASK_OFFER_PAIRS: readonly AskOfferPair[] = [
  { tag: 'seed funding', asks: 7, offers: 5, askRoles: ['founder'], offerRoles: ['investor'] },
  { tag: 'series A intros', asks: 5, offers: 4, askRoles: ['founder'], offerRoles: ['investor'] },
  {
    tag: 'climate-tech deal flow',
    asks: 4,
    offers: 3,
    askRoles: ['investor'],
    offerRoles: ['founder', 'community_builder'],
  },
  {
    tag: 'technical co-founder',
    asks: 3,
    offers: 3,
    askRoles: ['founder'],
    offerRoles: ['operator', 'student'],
  },
  {
    tag: 'intro to Stripe',
    asks: 2,
    offers: 2,
    askRoles: ['founder'],
    offerRoles: ['operator', 'investor'],
  },
  {
    tag: 'hardware manufacturing',
    asks: 3,
    offers: 2,
    askRoles: ['founder'],
    offerRoles: ['operator'],
  },
  { tag: 'first sales hire', asks: 4, offers: 3, askRoles: ['founder'], offerRoles: ['operator'] },
  {
    tag: 'US market entry',
    asks: 4,
    offers: 3,
    askRoles: ['founder', 'operator'],
    offerRoles: ['operator', 'investor'],
  },
  {
    tag: 'MDR regulatory advice',
    asks: 2,
    offers: 2,
    askRoles: ['founder'],
    offerRoles: ['operator', 'other'],
  },
  {
    tag: 'LP introductions',
    asks: 3,
    offers: 2,
    askRoles: ['investor'],
    offerRoles: ['investor', 'other'],
  },
  {
    tag: 'design partner in insurance',
    asks: 2,
    offers: 2,
    askRoles: ['founder'],
    offerRoles: ['operator'],
  },
  {
    tag: 'warehouse space in Rotterdam',
    asks: 2,
    offers: 1,
    askRoles: ['founder'],
    offerRoles: ['operator'],
  },
]

/**
 * Asks and offers nobody on the other side carries. Without them every ask in the database would
 * be a match, and a duplicate-free introduction engine would look far better than it is.
 */
export const UNMATCHED_ASKS: readonly string[] = [
  'office space in Lisbon',
  'a co-founder for a legaltech idea',
  'podcast guests',
  'a fractional CFO',
  'beta testers in the Netherlands',
  'advice on ESOP for a Swiss GmbH',
  'a design agency for a rebrand',
]

export const UNMATCHED_OFFERS: readonly string[] = [
  'public speaking',
  'brand photography',
  'board seats',
  'help with EU grant applications',
  'a spare desk in Berlin Mitte',
  'introductions to Nordic family offices',
  'code review for Rust services',
]

/** `how_we_met`, written as sentences a person would actually type (§4.1). */
export const HOW_WE_MET: readonly string[] = [
  'Met at Bits & Pretzels, queue for coffee on day two.',
  'Introduced by a mutual portfolio founder over email.',
  'Sat next to each other at the Munich Climate Circle dinner.',
  'Cold inbound on LinkedIn that turned out to be worth taking.',
  'We were in the same accelerator cohort in 2021.',
  'Spoke after her talk at the Zurich Deeptech Meetup.',
  'Worked together at a previous company; kept in touch since.',
  'Met through the Female Founders Berlin demo night.',
  'Introduced by an angel who is in both cap tables.',
  'Ran into each other at a customer workshop in Hamburg.',
  'He reached out after reading the fundraising post.',
  'Met at the Amsterdam Angels Breakfast in spring.',
  'University friend of a co-founder.',
  'Panel together at an industry conference in Vienna.',
  'Came through the Founders Guild Europe Slack.',
]

/** `notes` — short, specific, and never a paragraph of filler. */
export const NOTES: readonly string[] = [
  'Prefers a call to a written update. Two young kids, so mornings are hard.',
  'Raising again in the second half of the year; wants a warm intro, not a deck.',
  'Deeply sceptical about anything with "AI" in the first sentence. Lead with the metric.',
  'Was at the old company before this one — knows the manufacturing world properly.',
  'Runs the internal angel syndicate; can move €50k without a committee.',
  'Best reached on Signal. Email goes unread for weeks.',
  'Interested in board work now that the exit has closed.',
  'Very generous with introductions; reciprocate.',
  'Moving to Zurich in the autumn. Update the city then.',
  'Wants to hire a first sales person and keeps asking for candidates.',
  'Owns the vendor relationship on the corporate side. Real budget.',
  'Has a strong view on pricing; worth a call before the next round.',
]

/** Interaction titles that read like a real timeline, per type. */
export const INTERACTION_TITLES = {
  Meeting: [
    'Coffee in Schwabing',
    'Office visit',
    'Kick-off with the team',
    'Catch-up after the round',
    'Lunch near the Hauptbahnhof',
    'Walk-and-talk along the Isar',
    'Deep dive on the roadmap',
    'Breakfast before the conference',
  ],
  Call: [
    'Intro call',
    'Follow-up call on the pilot',
    'Quick call about the term sheet',
    'Monthly check-in',
    'Call about the hiring plan',
    'Debrief after the workshop',
  ],
  Email: [
    'Sent the deck',
    'Answered the diligence questions',
    'Shared the investor update',
    'Reply on pricing',
    'Forwarded the customer intro',
    'Sent the notes from the call',
  ],
  Message: [
    'WhatsApp about the event',
    'LinkedIn message on the new role',
    'Quick ping about the intro',
    'Signal thread on the launch',
  ],
  Intro: [
    'Introduced to a seed investor',
    'Introduced to a manufacturing partner',
    'Introduced to a design partner',
    'Double opt-in intro to a candidate',
    'Passed on an intro to a customer',
  ],
  Event: [
    'Bits & Pretzels',
    'Munich Climate Circle dinner',
    'Female Founders Berlin demo night',
    'Zurich Deeptech Meetup',
    'Amsterdam Angels Breakfast',
    'Portfolio day',
  ],
  Note: [
    'Note after the call',
    'Context from a mutual friend',
    'Thoughts on the fundraise',
    'What they are looking for',
    'Reminder of the last conversation',
  ],
} as const

/** Interaction bodies, chosen by type. Markdown-light, because §4.1 says the body is markdown. */
export const INTERACTION_BODIES: readonly string[] = [
  'Talked about the next round. Wants to close by the end of the quarter and is looking for a lead who has done hardware before.',
  'Pilot is live with two customers. Blocker is procurement, not the product.',
  'They are hiring a first sales person and asked whether I know anyone from the manufacturing world.',
  'Went through the numbers: revenue is up, churn is the thing to watch. Agreed to talk again in six weeks.',
  'Mostly personal. Moving house, new team, generally in good spirits.',
  'Wants an introduction to someone who has taken a medical device through MDR.',
  'Short conversation at the event. Follow up properly — worth the time.',
  'Explained the storage thesis. They are not investing in energy this year but offered to forward it.',
  'Asked for feedback on the pricing page. Sent notes afterwards.',
  'Good conversation about what happens after the exit. Board seats, angel cheques, maybe an EIR role.',
  'They offered to introduce us to their contact at a large insurer. Said yes; waiting on the double opt-in.',
  'Debrief after the workshop. Two concrete follow-ups on my side.',
]

/** Follow-up titles. Half are the "stay in touch" kind, half are concrete tasks. */
export const FOLLOW_UP_TITLES: readonly string[] = [
  'Send the intro to the seed investor',
  'Check in on the fundraise',
  'Share the manufacturing contact',
  'Quarterly catch-up',
  'Ask how the pilot went',
  'Send feedback on the deck',
  'Invite to the climate dinner',
  'Follow up on the hiring plan',
  'Introduce to a design partner',
  'Wish a happy work anniversary',
  'Ask for the LP introduction',
  'Send the notes from the workshop',
  'Reconnect before the conference',
  'Check whether they closed the round',
  'Forward the regulatory contact',
]

export const FOLLOW_UP_NOTES: readonly string[] = [
  'Promised this on the call — do not let it slip.',
  'They asked twice already.',
  'Only worth doing if the round is still open.',
  'Keep it short; they read on the phone.',
  'Ask about the family too.',
]

/** A slug-safe stem for websites and LinkedIn URLs, so both are derivable from one name. */
export function handleOf(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
