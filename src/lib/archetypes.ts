// Stock characters a series cast member can start from. Picking one fills
// only the empty fields, so a template never overwrites the writer's work.
import type { CastMember } from "./types";

export type ArchetypeFamily = "Commedia" | "Sitcom" | "Monster of the week";

export interface Archetype {
  name: string;
  family: ArchetypeFamily;
  want: string;
  flaw: string;
  engine: string;
  voice_notes: string;
}

export const ARCHETYPES: Archetype[] = [
  // Commedia dell'arte masks
  { name: "Arlecchino", family: "Commedia",
    want: "Food, rest, and to get through the day without being caught.",
    flaw: "Agrees to everything and remembers nothing.",
    engine: "Serves two masters at once and has to keep them from meeting.",
    voice_notes: "Quick, sing-song, cheerful even while lying. Undercuts tension with appetite." },
  { name: "Pantalone", family: "Commedia",
    want: "To keep his money and still look important.",
    flaw: "Miserly, vain, and sure he is still desirable.",
    engine: "Blocks the young lovers; every plan costs him money or dignity.",
    voice_notes: "Querulous, wheedling, counts things aloud. Complains before anything has happened." },
  { name: "Il Dottore", family: "Commedia",
    want: "To be recognised as the cleverest person in the room.",
    flaw: "Knows a little about everything and is wrong about all of it.",
    engine: "Answers simple questions with long, confident, useless lectures.",
    voice_notes: "Pompous, Latin-ish, sentences that never land. Cannot be interrupted." },
  { name: "Il Capitano", family: "Commedia",
    want: "Glory, and for everyone to believe his stories.",
    flaw: "A coward who brags.",
    engine: "Boasts big, then meets the smallest real danger and flees.",
    voice_notes: "Booming, grandiose, foreign oaths. Volume drops to a squeak under threat." },
  { name: "Colombina", family: "Commedia",
    want: "To get what she wants from the fools around her and keep her freedom.",
    flaw: "Enjoys the game a little too much.",
    engine: "The only one who sees clearly; quietly steers every scheme.",
    voice_notes: "Dry, sharp, amused. Short lines that end arguments." },
  { name: "Innamorato", family: "Commedia",
    want: "The beloved, at any cost.",
    flaw: "So in love they are useless.",
    engine: "Grand romantic declarations at exactly the wrong moment.",
    voice_notes: "Breathless and poetic. Sighs. Talks about feelings no one asked about." },
  // Sitcom stock types
  { name: "The straight man", family: "Sitcom",
    want: "For one normal day.",
    flaw: "Needs to be right; can be dragged into anything to prove it.",
    engine: "Reacts to the madness around them, then cracks and becomes the worst offender.",
    voice_notes: "Measured, exasperated. Repeats the absurd thing back as a question." },
  { name: "The schemer", family: "Sitcom",
    want: "The shortcut to money, status or revenge.",
    flaw: "Overcomplicates; every plan has one plan too many.",
    engine: "Launches the episode's scheme and doubles down as it collapses.",
    voice_notes: "Fast, persuasive, conspiratorial. 'Okay, okay, hear me out.'" },
  { name: "The wildcard", family: "Sitcom",
    want: "Whatever caught their attention this minute.",
    flaw: "No sense of consequence.",
    engine: "Enters with a non-sequitur and changes the direction of the scene.",
    voice_notes: "Unpredictable rhythm, sincere about absurd things." },
  { name: "The sweetheart", family: "Sitcom",
    want: "For everyone to get along.",
    flaw: "Can't say no; hides the truth to spare feelings.",
    engine: "A small kind lie that spirals into the B plot.",
    voice_notes: "Warm, apologetic, over-explains. Gets very quiet when guilty." },
  { name: "The authority", family: "Sitcom",
    want: "Order, and credit for it.",
    flaw: "Rules over sense.",
    engine: "Arrives at the worst moment and enforces the rule that makes things worse.",
    voice_notes: "Clipped, procedural, a catchphrase of disapproval." },
  // Monster of the week roles
  { name: "The believer", family: "Monster of the week",
    want: "Proof.",
    flaw: "Sees the supernatural everywhere, even when it's not there.",
    engine: "Spots the pattern first and runs toward the danger.",
    voice_notes: "Excited, fast, references obscure lore." },
  { name: "The skeptic", family: "Monster of the week",
    want: "A rational explanation.",
    flaw: "Refuses the obvious until it bites.",
    engine: "Debunks everything until the monster turns up, then is the most competent in the fight.",
    voice_notes: "Dry, precise, sarcastic under pressure." },
  { name: "The researcher", family: "Monster of the week",
    want: "To understand the thing before it kills anyone.",
    flaw: "Would rather read about it than act.",
    engine: "Delivers the weakness or rule at the act-three turn.",
    voice_notes: "Bookish, digressive, lights up at a footnote." },
  { name: "The muscle", family: "Monster of the week",
    want: "To protect the group.",
    flaw: "Hits first, asks never.",
    engine: "Charges in early and makes the first encounter go wrong.",
    voice_notes: "Few words, blunt, gallows humour." },
];

export const ARCHETYPE_FAMILIES: ArchetypeFamily[] = ["Commedia", "Sitcom", "Monster of the week"];

/** Fill a cast member's empty fields from an archetype. */
export function applyArchetype(m: CastMember, a: Archetype): CastMember {
  return {
    ...m,
    archetype: a.name,
    want: m.want || a.want,
    flaw: m.flaw || a.flaw,
    engine: m.engine || a.engine,
    voice_notes: m.voice_notes || a.voice_notes,
  };
}

export function blankCastMember(name = ""): CastMember {
  return {
    id: `cast_${Math.random().toString(36).slice(2, 8)}`,
    name, archetype: "", description: "", want: "", flaw: "", engine: "",
    voice_notes: "", catchphrases: [], lazzi: [], never: "", relationships: [],
    library_id: null,
  };
}

/** Series formats. `format` on disk is the id; free text is allowed too. */
export const SERIES_FORMATS: { id: string; label: string }[] = [
  { id: "sitcom", label: "Sitcom" },
  { id: "monster_of_the_week", label: "Monster of the week" },
  { id: "commedia", label: "Commedia dell'arte" },
  { id: "anthology", label: "Anthology" },
];

export function formatLabel(id: string): string {
  return SERIES_FORMATS.find((f) => f.id === id)?.label ?? id;
}

/** Starting formulas by format; loaded into the Bible on request. */
export const FORMULA_PRESETS: Record<string, { name: string; description: string }[]> = {
  sitcom: [
    { name: "Cold open", description: "A self-contained bit that sets the episode's theme; ends on a button." },
    { name: "Act One", description: "Set up the A plot (the scheme or problem) and the B plot." },
    { name: "Act Two", description: "Complications. The A plot escalates; the B plot gets in the way." },
    { name: "Act Three", description: "The plots collide; everything goes wrong at once; a resolution that resets the status quo." },
    { name: "Tag", description: "A short closing beat with a callback." },
  ],
  monster_of_the_week: [
    { name: "Cold open", description: "A victim meets the thing. We hear it, barely." },
    { name: "The case", description: "The team learns what happened; banter; someone has a theory." },
    { name: "Investigation", description: "Following the pattern; a witness or a clue; the lore starts to surface." },
    { name: "First encounter", description: "It goes badly. Someone is hurt or wrong." },
    { name: "The turn", description: "The rule or weakness is found, at a cost." },
    { name: "Confrontation", description: "The plan, the fight, the clever reversal." },
    { name: "Coda", description: "Quiet banter afterwards; one character beat; one thread left hanging." },
  ],
  commedia: [
    { name: "Prologue", description: "A servant tells the audience the situation." },
    { name: "The obstacle", description: "The lovers want to marry; the old man forbids it for money or vanity." },
    { name: "The scheme", description: "The servants hatch a plan; disguises and mistaken identities." },
    { name: "Lazzi", description: "The plan falls apart in comic set pieces." },
    { name: "Unmasking", description: "Identities revealed; the old man outwitted; the lovers united." },
  ],
  anthology: [
    { name: "Hook", description: "An ordinary person in an ordinary place; one thing is wrong." },
    { name: "Rising", description: "The wrongness grows; the rules of this story emerge." },
    { name: "Twist", description: "The rule turns back on the protagonist." },
    { name: "Ending", description: "A final image or line that recontextualises everything." },
  ],
};
