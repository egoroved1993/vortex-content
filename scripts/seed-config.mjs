export const launchMix = {
  defaultCount: 320,
  lanes: {
    micro_moment: 0.55,
    mind_post: 0.45,
  },
  gameSources: {
    human: 0.5,
    ai: 0.5,
  },
  sourceProfiles: {
    ambiguous: 0.45,
    human_like: 0.45,
    slightly_too_clean: 0.1,
  },
  readReasons: {
    weird_observation: 0.18,
    confession: 0.16,
    microdrama: 0.15,
    overheard_truth: 0.13,
    identity_signal: 0.12,
    resentment: 0.1,
    tenderness: 0.09,
    useful_local: 0.07,
  },
  tones: {
    neutral: 0.35,
    irritated: 0.25,
    warm: 0.2,
    lonely: 0.12,
    uncanny: 0.08,
  },
};

export const readReasons = {
  confession: {
    id: "confession",
    label: "Confession",
    description: "A small weakness, contradiction, or embarrassing truth slips out.",
  },
  microdrama: {
    id: "microdrama",
    label: "Microdrama",
    description: "A tiny conflict, tension, or unresolved social scene is happening.",
  },
  weird_observation: {
    id: "weird_observation",
    label: "Weird Observation",
    description: "A detail is too specific or strange to ignore.",
  },
  useful_local: {
    id: "useful_local",
    label: "Useful Local",
    description: "A local trick, pattern, or unofficial city knowledge.",
  },
  resentment: {
    id: "resentment",
    label: "Resentment",
    description: "The text carries everyday irritation or social friction.",
  },
  tenderness: {
    id: "tenderness",
    label: "Tenderness",
    description: "A small warm moment softens the city for a second.",
  },
  identity_signal: {
    id: "identity_signal",
    label: "Identity Signal",
    description: "The message implies a specific kind of person without explaining them.",
  },
  overheard_truth: {
    id: "overheard_truth",
    label: "Overheard Truth",
    description: "A fragment of speech or public behavior hints at a whole life.",
  },
};

export const sourceProfiles = {
  ambiguous: {
    id: "ambiguous",
    label: "Ambiguous",
    guidance:
      "Blend highly human specificity with suspiciously clean control. The reader should be able to argue either side with confidence.",
  },
  human_like: {
    id: "human_like",
    label: "Human-Like",
    guidance:
      "Lean messier and more lived-in, but still keep enough composure that it does not become an easy human guess.",
  },
  slightly_too_clean: {
    id: "slightly_too_clean",
    label: "Slightly Too Clean",
    guidance:
      "Let the writing feel almost too neatly observed or structured, but ground it with one real detail so it does not become obvious AI.",
  },
};

export const contentLanes = {
  micro_moment: {
    id: "micro_moment",
    label: "City Micro-Moment",
    guidance:
      "The message should feel like a lived scene, overheard line, tiny ritual, or sharply observed fragment of daily city life.",
  },
  mind_post: {
    id: "mind_post",
    label: "Mind Post",
    guidance:
      "The message should feel like a compact public thought: a take, mini-theory, complaint with a thesis, or social diagnosis written by someone with a strong angle.",
  },
};

export const tones = {
  neutral: {
    id: "neutral",
    guidance: "Emotion is present but understated. No melodrama.",
  },
  irritated: {
    id: "irritated",
    guidance: "Low-level annoyance, friction, or social fatigue.",
  },
  warm: {
    id: "warm",
    guidance: "Quiet warmth, gratitude, or softness.",
  },
  lonely: {
    id: "lonely",
    guidance: "A little isolated, late, tired, or inward-looking.",
  },
  uncanny: {
    id: "uncanny",
    guidance: "Slightly off, absurd, or eerie in a believable city way.",
  },
};

export const textures = [
  {
    id: "abrupt_end",
    guidance: "End slightly early instead of landing a perfect conclusion.",
    fits: ["ambiguous", "human_like"],
  },
  {
    id: "awkward_phrase",
    guidance: "Include one mildly awkward phrase or clumsy wording.",
    fits: ["ambiguous", "human_like"],
  },
  {
    id: "suspiciously_neat",
    guidance: "Keep the syntax controlled and compact without becoming essay-like.",
    fits: ["ambiguous", "slightly_too_clean"],
  },
  {
    id: "spoken_fragment",
    guidance: "Use spoken cadence or a remembered fragment of speech.",
    fits: ["human_like", "ambiguous"],
  },
  {
    id: "one_specific_detail",
    guidance: "Anchor everything around one tiny concrete detail.",
    fits: ["ambiguous", "slightly_too_clean", "human_like"],
  },
  {
    id: "mild_contradiction",
    guidance: "Let the speaker contradict themselves a little.",
    fits: ["human_like", "ambiguous"],
  },
  {
    id: "polished_but_local",
    guidance: "The text reads almost too elegant, but a local detail keeps it alive.",
    fits: ["slightly_too_clean", "ambiguous"],
  },
  {
    id: "underexplained",
    guidance: "Do not explain the context fully. Trust the moment.",
    fits: ["human_like", "ambiguous"],
  },
];

export const personas = [
  {
    id: "tired_office_worker",
    label: "Tired office worker",
    guidance: "Dry, observant, slightly overstimulated by routine.",
    linkBehavior: "occasional",
    tags: ["work", "commute", "cost", "resentment"],
  },
  {
    id: "student_in_transition",
    label: "Student in transition",
    guidance: "Half-serious, socially porous, noticing status and money.",
    tags: ["dating", "night", "cost", "commute"],
  },
  {
    id: "service_worker",
    label: "Service worker",
    guidance: "Good at reading people, tired of performative behavior.",
    linkBehavior: "occasional",
    tags: ["food", "work", "tourist", "resentment"],
  },
  {
    id: "recent_expat",
    label: "Recent expat",
    guidance: "Still translating the city in their head before speaking.",
    linkBehavior: "occasional",
    tags: ["language", "expat", "identity", "confession"],
  },
  {
    id: "long_time_local",
    label: "Long-time local",
    guidance: "Specific, territorial, lightly defensive about change.",
    linkBehavior: "occasional",
    tags: ["local", "nostalgia", "gentrification", "city_pride"],
  },
  {
    id: "lonely_night_owl",
    label: "Lonely night owl",
    guidance: "Inward, late, slightly strange, notices how public space shifts after dark.",
    tags: ["night", "late", "uncanny", "confession"],
  },
  {
    id: "young_parent",
    label: "Young parent",
    guidance: "Thinks in logistics, tiny kindnesses, and quiet exhaustion.",
    tags: ["morning", "cost", "identity", "tenderness"],
  },
  {
    id: "serial_dater",
    label: "Serial dater",
    guidance: "Funny, self-aware, a little tired of city romance scripts.",
    linkBehavior: "occasional",
    tags: ["dating", "night", "confession", "microdrama"],
  },
  {
    id: "financially_stressed_renter",
    label: "Financially stressed renter",
    guidance: "Measures the city through price, compromise, and shame.",
    linkBehavior: "occasional",
    tags: ["cost", "gentrification", "resentment", "identity"],
  },
  {
    id: "sports_obsessive",
    label: "Sports obsessive",
    guidance: "Emotionally public, hears mood swings in crowds and bars.",
    tags: ["sports", "overheard", "microdrama", "city_pride"],
  },
  {
    id: "culture_snob",
    label: "Culture snob",
    guidance: "Sharp eye for aesthetic fraud, but secretly sentimental.",
    linkBehavior: "occasional",
    tags: ["street_art", "food", "gentrification", "resentment"],
  },
  {
    id: "socially_awkward_observer",
    label: "Socially awkward observer",
    guidance: "Notices everything, says less than they should, remembers odd details.",
    tags: ["weird", "overheard", "commute", "random"],
  },
  {
    id: "immigrant_balancing_languages",
    label: "Immigrant balancing languages",
    guidance: "Lives inside translation lag and small misunderstandings.",
    tags: ["language", "expat", "identity", "confession"],
  },
  {
    id: "burned_out_remote_worker",
    label: "Burned-out remote worker",
    guidance: "Urban life is filtered through screens, rent, and soft dissociation.",
    linkBehavior: "occasional",
    tags: ["work", "cost", "late", "confession"],
  },
  {
    id: "older_local_memory_keeper",
    label: "Older local memory keeper",
    guidance: "Measures the present against vanished shops, rhythms, and manners.",
    tags: ["nostalgia", "gentrification", "local", "city_pride"],
  },
  {
    id: "russian_emigre",
    label: "Russian émigré",
    guidance: "Arrived 1-3 years ago, left Russia voluntarily or not. Observes Barcelona with the precision of someone comparing it daily to Moscow or St. Petersburg. Dry, occasionally surprised by warmth, sometimes melancholic without drama.",
    languageOverride: "Write in Russian. Embed Spanish nouns naturally where a Russian expat would borrow them — piso, metro, mercado, empadronamiento, bono social, barrio — without translating them back to Russian. Do not transliterate Spanish into Cyrillic. Keep Russian casual and unpolished, not literary.",
    linkBehavior: "occasional",
    cityOnly: "barcelona",
    tags: ["expat", "identity", "confession", "language"],
  },
  {
    id: "south_asian_londoner",
    label: "South Asian Londoner",
    guidance: "British-born or raised, navigates dual identity without drama. Specific about food, family expectations, and neighbourhood geography. Dry self-awareness about being both insider and outsider simultaneously.",
    languageOverride: "Write in casual British English. Cultural references can include South Asian specifics — specific foods, family dynamics, Southall or Wembley or Tooting — used without explanation, as natural as any other London reference. No accent parody, no exoticisation.",
    cityOnly: "london",
    tags: ["identity", "local", "food", "commute"],
  },
  {
    id: "west_african_londoner",
    label: "West African Londoner",
    guidance: "Nigerian or Ghanaian background, London-raised or long-term resident. Direct, ambitious, community-minded. Notices class and race in city life without making it the point of every message.",
    languageOverride: "Write in confident British English with occasional West African cadences where natural — directness, specific cultural references, Nigerian/Ghanaian phrasing that sounds like someone who grew up switching registers. No parody or exaggeration.",
    cityOnly: "london",
    tags: ["identity", "work", "cost", "local"],
  },
  {
    id: "turkish_berliner",
    label: "Turkish Berliner",
    guidance: "Second or third generation, born in Berlin, Turkish family. Neukölln or Wedding. Knows the city better than most but is still read as foreign. Sharp about this contradiction without performing it.",
    languageOverride: "Write in casual English. Drop Turkish words where a Berlin Turkish speaker naturally would — abi, lan, helal, specific phrases — without translating. References Neukölln, Wedding, specific streets. Never writes like a tourist in their own city.",
    cityOnly: "berlin",
    tags: ["identity", "local", "resentment", "language"],
  },
  {
    id: "american_expat_berlin",
    label: "American expat in Berlin",
    guidance: "Moved from NYC or LA 2-4 years ago. Slightly evangelical about Berlin. Compares everything to home in ways that are sometimes insightful and sometimes embarrassing. Processing freedom and bureaucracy simultaneously.",
    languageOverride: "Write in American English. Occasional German words used with visible effort — Kiez, Späti, Anmeldung — as someone who learned them recently. Comparisons to New York or California appear naturally. Currency: EUR — use €, never dollars.",
    cityOnly: "berlin",
    tags: ["expat", "identity", "work", "confession"],
  },
  {
    id: "mission_latino",
    label: "Mission District Latino",
    guidance: "SF Mission resident — Mexican or Central American family background, 2nd generation or recent arrival. Watches the neighbourhood change around them. Food, community, displacement, loyalty.",
    languageOverride: "Write in casual Spanglish — Spanish with English mixed in, or English with Spanish phrases, however it flows naturally. Not a bilingual performance, just how people actually talk: 'el landlord me mandó un notice', 'la taquería packed with techies taking photos'. Currency: USD — use $.",
    linkBehavior: "occasional",
    cityOnly: "sf",
    tags: ["local", "gentrification", "food", "identity"],
  },
];

export const cities = [
  {
    id: "london",
    name: "London",
    languageGuidance: "Write in casual contemporary English with mild London dryness. No fake cockney. Currency: GBP — use £ and p (pounds/pence), never dollars or euros.",
    languageDistribution: [
      { lang: "en", weight: 0.85, guidance: "Write in casual contemporary English with mild London dryness. No fake cockney. Currency: GBP — use £ and p (pounds/pence), never dollars or euros." },
      { lang: "ru", weight: 0.15, guidance: "Write in casual Russian. London-specific words left in English where natural — tube, Oyster, flat share, council tax, Tesco. Not literary Russian — casual, как в чате." },
    ],
    defaultAnchors: [
      "victoria line platform",
      "zone 2 flat share",
      "corner shop",
      "brick lane queue",
      "overground carriage",
      "pub carpet",
      "rain on the bus window",
      "pret line before 9",
    ],
    topicAnchors: {
      commute_thought: ["victoria line", "overground delays", "tube platform heat"],
      cost_of_living: ["zone 2 flat share", "rent jumping on the same street", "price of coffee before work"],
      food_moment: ["pret queue", "greasy spoon", "brick lane bagel place"],
      neighborhood_vibe: ["hackney side street", "peckham rooftop", "islington high street"],
      local_secret: ["shortcut through the estate", "back way into the park", "the cheap lunch counter under the office block"],
      night_out: ["dalston smoking area", "pub garden after midnight", "night bus home"],
      tourist_vs_local: ["camden lock crowd", "notting hill weekend", "tower bridge commute photos"],
      gentrification: ["new natural wine bar", "closed off-licence", "rent jumping on the same street"],
      sports_fan: ["arsenal pub", "spurs group chat leaking into real life", "people shouting at a screen in a corner bar"],
      weather_mood: ["drizzle on the bus window", "wet trainers all day", "sun for exactly twenty minutes"],
      humor: ["queue that moved exactly one person in twelve minutes", "tfl apology that explains nothing", "the one pigeon that always gets on at victoria"],
      city_rumor: ["heard that whole block is being sold off", "someone said the lease isn't renewed", "apparently the council already decided months ago"],
      ai_anxiety: ["cv written by chatgpt vs cv written by someone tired", "ai summary of a meeting i was in", "menu that reads like it was prompted"],
      personal_story: ["landlord who kept the deposit", "stranger on the night bus", "first flat viewing that went wrong", "the thing that happened at a work leaving do"],
    },
    personaBias: ["tired_office_worker", "long_time_local", "serial_dater", "culture_snob", "south_asian_londoner", "west_african_londoner"],
  },
  {
    id: "berlin",
    name: "Berlin",
    languageGuidance: "Write in English that feels local to Berlin expat/local life. A little bluntness is okay. No cliches about techno unless earned. Currency: EUR — use € (euros), never dollars or pounds.",
    languageDistribution: [
      { lang: "en", weight: 0.50, guidance: "Write in English that feels local to Berlin expat/local life. A little bluntness is okay. No cliches about techno unless earned. Currency: EUR — use € (euros), never dollars or pounds." },
      { lang: "de", weight: 0.25, guidance: "Schreib auf lockerem Deutsch — wie jemand der in Berlin lebt und tippt. Umgangssprache, nicht Hochdeutsch. Spezifische Berliner Wörter (Späti, Kiez, Anmeldung) einfach benutzen. Währung: EUR — benutze € (Euro)." },
      { lang: "ru", weight: 0.25, guidance: "Write in casual Russian. Berlin-specific words left in original where natural — Anmeldung, WG, Späti, Kiez, Bürgeramt. Casual, не литературный русский." },
    ],
    defaultAnchors: [
      "u8 platform",
      "spati fridge",
      "ringbahn seat fabric",
      "friedrichshain courtyard",
      "tempelhof wind",
      "sunday closure",
      "wg kitchen",
      "canal path at dusk",
    ],
    topicAnchors: {
      commute_thought: ["u8 smell", "ringbahn delay", "tram stop in the cold"],
      cost_of_living: ["rent discourse in a once-cheap block", "wg kitchen math", "spati price shock"],
      food_moment: ["doner line", "spati beer", "bakery closed on sunday"],
      neighborhood_vibe: ["neukolln pavement", "friedrichshain courtyard", "prenzlauer berg stroller zone"],
      local_secret: ["which spati actually stocks decent wine", "park corner after dark", "quiet canal route"],
      night_out: ["club queue at 2am", "someone still wearing last night on the ubahn", "smoking area philosophy"],
      language_barrier: ["switching to English too fast", "half-understood German in the post office", "apartment viewing small talk"],
      expat_life: ["wg kitchen politics", "visa office fatigue", "missing home in rewe"],
      gentrification: ["new ceramic cafe", "rent discourse in a once-cheap block", "old kneipe replaced with pale wood"],
      street_art: ["poster layers on one wall", "half-buffed mural", "marker on the train door"],
      humor: ["ubahn door that closes on the exact second you reach it", "spati owner who clearly hates you but still serves you", "the one ringbahn seat that's always slightly damp"],
      city_rumor: ["heard that club is being converted", "someone in the wg said the landlord already sold", "apparently the bar on the corner knew months ago"],
      ai_anxiety: ["job listing that gpt wrote and a gpt applied to", "translation app that understood my german better than i did", "gallery piece that was ai-made and everyone clapped anyway"],
      personal_story: ["visa office waiting room story", "wg roommate who suddenly moved out", "anmeldung appointment that went sideways", "person met at a spati at 2am"],
    },
    personaBias: ["recent_expat", "immigrant_balancing_languages", "lonely_night_owl", "financially_stressed_renter", "turkish_berliner", "american_expat_berlin"],
  },
  {
    id: "sf",
    name: "San Francisco",
    languageGuidance: "Write in modern American English. Avoid startup parody unless the scene really supports it. Currency: USD — use $ and cents (dollars), never euros or pounds.",
    languageDistribution: [
      { lang: "en", weight: 0.60, guidance: "Write in modern American English. Avoid startup parody unless the scene really supports it. Currency: USD — use $ and cents (dollars), never euros or pounds." },
      { lang: "es", weight: 0.25, guidance: "Escribe en español coloquial — como alguien del Mission o de un barrio latino de SF. Mezcla palabras en inglés donde sea natural: rent, BART, Muni, tech bro, layoff. Moneda: USD — usa $ (dólares)." },
      { lang: "ru", weight: 0.15, guidance: "Write in casual Russian. SF-specific words left in English where natural — BART, Muni, tech, startup, layoff, rent control. Casual Russian, не литературный." },
    ],
    defaultAnchors: [
      "muni delay",
      "fog pushing into the sunset",
      "bart platform",
      "mission burrito line",
      "tech shuttle stop",
      "dolores hill",
      "corner store cat",
      "rent-controlled building",
    ],
    topicAnchors: {
      commute_thought: ["muni ghost arrival time", "bart escalator", "tech shuttle pickup"],
      food_moment: ["mission burrito line", "coffee that costs too much even here", "corner bakery before the fog clears"],
      neighborhood_vibe: ["mission sidewalk energy", "sunset district quiet", "north beach block on a weekday"],
      local_secret: ["which hill is worth climbing", "where the line moves faster than it looks", "the bench with the weirdly best view"],
      weather_mood: ["fog taking half the afternoon", "microclimate betrayal", "hoodie by 4pm"],
      work_stress: ["calendar full by 9:15", "startup kitchen snacks as emotional support", "slack message before sunrise"],
      cost_of_living: ["roommate math", "price of coffee vs dignity", "people discussing rent like weather"],
      tourist_vs_local: ["painted ladies performance", "cable car photo bottleneck", "someone calling every incline a hike"],
      political_frustration: ["city meeting energy leaking into daily life", "policy language vs sidewalk reality", "everyone has an opinion before breakfast"],
      humor: ["bart arrival prediction that's technically a creative writing exercise", "tech person explaining the mission to someone who grew up there", "the way everyone in sf has a startup idea and also can't afford lunch"],
      city_rumor: ["heard that whole street is being rezoned", "someone said the sf standard already has the story", "apparently the city knew about this last year"],
      ai_anxiety: ["ai therapist ad on the muni", "startup that replaced half its team and then wrote a blog post about human creativity", "chatgpt answer to a sf specific question that was completely wrong but confident"],
      personal_story: ["roommate who left without notice", "layoff that came on a tuesday", "stranger at dolores park who said something true", "the coffee shop where something changed"],
    },
    personaBias: ["burned_out_remote_worker", "service_worker", "financially_stressed_renter", "socially_awkward_observer", "mission_latino"],
  },
  {
    id: "barcelona",
    name: "Barcelona",
    languageGuidance: "Write in casual English that can lightly reflect multilingual city life. A small Catalan or Spanish detail is okay if natural. Currency: EUR — use € (euros), never dollars or pounds. Never say 'bucks'.",
    languageDistribution: [
      { lang: "en", weight: 0.35, guidance: "Write in casual English that can lightly reflect multilingual city life. A small Catalan or Spanish detail is okay if natural. Currency: EUR — use € (euros), never dollars or pounds." },
      { lang: "es", weight: 0.35, guidance: "Escribe en español coloquial — como alguien que vive en Barcelona. Puedes mezclar alguna palabra en catalán donde sea natural (molt bé, barri, colla). No es castellano formal — es como escribiría alguien en un chat. Moneda: EUR — usa € (euros)." },
      { lang: "ru", weight: 0.25, guidance: "Write in casual Russian. Barcelona-specific words left in Spanish/Catalan where natural — piso, metro, empadronamiento, barrio, vermut, mercat. Casual Russian, не литературный." },
      { lang: "ca", weight: 0.05, guidance: "Escriu en català col·loquial — com algú que viu a Barcelona i escriu al mòbil. No formal. Moneda: EUR — usa € (euros)." },
    ],
    defaultAnchors: [
      "superblock corner",
      "metro line 3",
      "gracia square",
      "beach in winter",
      "tourist suitcase wheels",
      "late dinner table",
      "raval balcony",
      "vermut hour",
    ],
    topicAnchors: {
      commute_thought: ["metro line 3 heat", "scooter noise before coffee", "walking uphill with shopping bags"],
      cost_of_living: ["airbnb staircase politics", "price jump on the same block", "lloguer math before coffee"],
      food_moment: ["menu del dia", "vermut hour", "tiny coffee at the bar"],
      neighborhood_vibe: ["gracia square at dusk", "raval balcony scene", "barceloneta in off-season"],
      local_secret: ["which bakery still feels real", "the side street where the noise drops", "when the market queue is actually short"],
      night_out: ["drinks starting too late", "someone still outside at 3:30", "plaza voices echoing up the building"],
      tourist_vs_local: ["suitcase wheels on old pavement", "beach selfie crowd", "someone stopping in the bike lane to film a doorway"],
      gentrification: ["old bar replaced with matcha minimalism", "airbnb staircase politics", "price jump on the same block"],
      language_barrier: ["switching between spanish, catalan, and english badly", "ordering with rehearsed confidence", "missing the joke at the table"],
      expat_life: ["group chat full of people leaving and arriving", "still not sure where home is", "sunlight making everything easier than it is"],
      humor: ["tourist stopping in the bike lane to photograph a doorway", "menu del dia that changes every day but is always the same", "the barcelona way of being late that isn't actually rude"],
      city_rumor: ["senten que tanquen aquell bar", "algú va dir que el propietari ja ho ha venut", "apparently the building was sold and nobody told the tenants"],
      ai_anxiety: ["app that translates catalan and just gives you spanish", "instagram reel about barcelona that no person from barcelona would make", "ai travel guide that sent someone to a restaurant closed since 2019"],
      personal_story: ["NIE queue story", "landlord who showed up unannounced", "first time at the mercat understood something", "person met at a vermut bar who changed the afternoon"],
    },
    personaBias: ["recent_expat", "serial_dater", "long_time_local", "culture_snob", "russian_emigre"],
    personaLanguageOverrides: {
      long_time_local: "Write in Spanish with natural Catalan influence. Drop Catalan words or short phrases where they feel natural (molt bé, no cal, ara ja, tio/tia). No need to translate them. This is how educated Barcelona locals actually write.",
      immigrant_balancing_languages: "Write in casual Latin American Spanish (not Castilian). Mix in occasional English words for tech and work. Catalan words appear only as borrowed local vocabulary — metro, gràcies, bústia — not as fluent Catalan.",
      recent_expat: "Write in English. Include occasional Spanish insertions — menu items, street names, a local phrase — that feel rehearsed and slightly uncertain, not fluent.",
    },
  },
];

export const topics = {
  overheard: {
    id: "overheard",
    label: "Overheard",
    personaTags: ["overheard", "microdrama", "weird"],
    moments: [
      "The speaker catches one sentence in public and cannot stop replaying it.",
      "The speaker hears a line that reveals a whole relationship instantly.",
    ],
    angles: [
      { readReason: "overheard_truth", angle: "Use one spoken fragment that implies an entire life behind it." },
      { readReason: "microdrama", angle: "Make the overheard line part of a tiny public conflict." },
      { readReason: "confession", angle: "Show how the speaker became emotionally attached to something they only overheard." },
    ],
  },
  neighborhood_vibe: {
    id: "neighborhood_vibe",
    label: "Neighborhood vibe",
    personaTags: ["local", "identity", "resentment"],
    moments: [
      "The speaker is walking through an area and realizes what kind of people it now belongs to.",
      "A tiny ritual or repeated scene sums up the area better than any description could.",
    ],
    angles: [
      { readReason: "identity_signal", angle: "Let the neighborhood reveal who the speaker is." },
      { readReason: "resentment", angle: "Expose how the area performs itself or irritates the speaker." },
      { readReason: "tenderness", angle: "Find one small ritual that makes the neighborhood feel human." },
    ],
  },
  local_secret: {
    id: "local_secret",
    label: "Local secret",
    personaTags: ["local", "identity", "useful_local"],
    moments: [
      "The speaker shares an unofficial way the city really works.",
      "The speaker reveals a tiny trick that only regulars would know.",
    ],
    angles: [
      { readReason: "useful_local", angle: "Give a real tactic, pattern, or timing hack." },
      { readReason: "weird_observation", angle: "Reveal a local place used in a strange unofficial way." },
      { readReason: "identity_signal", angle: "Make the knowledge itself imply that the speaker earned it." },
    ],
  },
  weather_mood: {
    id: "weather_mood",
    label: "Weather mood",
    personaTags: ["confession", "resentment", "tenderness"],
    moments: [
      "The weather changes the speaker's behavior in a small revealing way.",
      "The city reacts to weather in a way that says something about the people in it.",
    ],
    angles: [
      { readReason: "confession", angle: "Weather exposes a tiny weakness or embarrassing habit." },
      { readReason: "resentment", angle: "Weather reveals how badly the city is built or run." },
      { readReason: "tenderness", angle: "Weather creates a brief moment of care or closeness." },
    ],
  },
  commute_thought: {
    id: "commute_thought",
    label: "Commute thought",
    personaTags: ["commute", "weird", "microdrama"],
    moments: [
      "The speaker has one recurring thought in transit that they would never admit elsewhere.",
      "A commute ritual is interrupted by a tiny social absurdity.",
    ],
    angles: [
      { readReason: "weird_observation", angle: "Show a transit detail only regular commuters notice." },
      { readReason: "microdrama", angle: "Build around a tiny public conflict or etiquette collapse." },
      { readReason: "confession", angle: "Let the commute force a small private truth to the surface." },
    ],
  },
  food_moment: {
    id: "food_moment",
    label: "Food moment",
    personaTags: ["food", "tenderness", "resentment"],
    moments: [
      "Food or coffee becomes the emotional center of a regular day.",
      "Ordering, paying, or being recognized reveals more than the meal itself.",
    ],
    angles: [
      { readReason: "identity_signal", angle: "Let the ordering habit say who the speaker is." },
      { readReason: "tenderness", angle: "Use a tiny act of recognition or care around food." },
      { readReason: "resentment", angle: "Let price or cafe culture quietly annoy the speaker." },
    ],
  },
  night_out: {
    id: "night_out",
    label: "Night out",
    personaTags: ["night", "dating", "microdrama"],
    moments: [
      "The speaker is between going home and staying out too late.",
      "A nightlife scene reveals how fragile or ridiculous everyone feels after midnight.",
    ],
    angles: [
      { readReason: "microdrama", angle: "Focus on one tiny emotional collapse or social tension at night." },
      { readReason: "overheard_truth", angle: "Use one sentence overheard outside a bar or club." },
      { readReason: "confession", angle: "Let the speaker realize something uncomfortable about themself at night." },
    ],
  },
  work_stress: {
    id: "work_stress",
    label: "Work stress",
    personaTags: ["work", "resentment", "confession"],
    moments: [
      "A tiny work detail says more about burnout than any big statement could.",
      "The speaker notices how work bleeds into the city outside the office.",
    ],
    angles: [
      { readReason: "confession", angle: "Show a small burnout truth rather than a dramatic rant." },
      { readReason: "resentment", angle: "Use one absurd work ritual or office habit." },
      { readReason: "identity_signal", angle: "Let class or job leak through naturally." },
    ],
  },
  tourist_vs_local: {
    id: "tourist_vs_local",
    label: "Tourist vs local",
    personaTags: ["local", "resentment", "city_pride"],
    moments: [
      "A tourist behavior and a local behavior collide in one scene.",
      "The speaker sees the city being consumed incorrectly in public.",
    ],
    angles: [
      { readReason: "resentment", angle: "Show how the city gets optimized for visitors over residents." },
      { readReason: "tenderness", angle: "Defend a local thing outsiders consistently miss." },
      { readReason: "weird_observation", angle: "Point out a small behavior tourists always misunderstand." },
    ],
  },
  gentrification: {
    id: "gentrification",
    label: "Gentrification",
    personaTags: ["cost", "local", "resentment"],
    moments: [
      "A replacement on one street says everything about how the area is changing.",
      "The speaker notices the neighborhood no longer speaks their language, literally or socially.",
    ],
    angles: [
      { readReason: "resentment", angle: "Use one concrete replacement, price jump, or aesthetic shift." },
      { readReason: "confession", angle: "Let the speaker admit how much this change actually hurts." },
      { readReason: "identity_signal", angle: "Make it obvious the speaker remembers the earlier version." },
    ],
  },
  language_barrier: {
    id: "language_barrier",
    label: "Language barrier",
    personaTags: ["language", "expat", "identity"],
    moments: [
      "The speaker prepares to speak and still misses the rhythm of the exchange.",
      "A small misunderstanding lands with disproportionate emotional weight.",
    ],
    angles: [
      { readReason: "confession", angle: "Show the shame or fatigue of rehearsing language in advance." },
      { readReason: "microdrama", angle: "Build around a tiny misunderstanding with real tension." },
      { readReason: "identity_signal", angle: "Let multilingual life leak into the phrasing itself." },
    ],
  },
  expat_life: {
    id: "expat_life",
    label: "Expat life",
    personaTags: ["expat", "identity", "confession"],
    moments: [
      "The speaker realizes they still do not belong, but not in a dramatic way.",
      "Home appears unexpectedly through one store, smell, phrase, or errand.",
    ],
    angles: [
      { readReason: "confession", angle: "Admit a small, non-heroic truth about not belonging." },
      { readReason: "tenderness", angle: "Let an accidental reminder of home soften the message." },
      { readReason: "weird_observation", angle: "Use the expat perspective to notice something locals ignore." },
    ],
  },
  dating_scene: {
    id: "dating_scene",
    label: "Dating scene",
    personaTags: ["dating", "microdrama", "confession"],
    moments: [
      "One date detail reveals the whole energy of city romance.",
      "The speaker catches themself repeating a dating script they claim to hate.",
    ],
    angles: [
      { readReason: "microdrama", angle: "Center one date detail that says everything." },
      { readReason: "resentment", angle: "Show how the city distorts flirting or intimacy." },
      { readReason: "confession", angle: "Make the speaker realize something embarrassing about themself." },
    ],
  },
  cost_of_living: {
    id: "cost_of_living",
    label: "Cost of living",
    personaTags: ["cost", "resentment", "identity"],
    moments: [
      "The speaker adapts to an absurd price and feels weirdly ashamed.",
      "A mundane purchase lands like a moral event.",
    ],
    angles: [
      { readReason: "resentment", angle: "Focus on something expensive that should not feel normal." },
      { readReason: "confession", angle: "Show humiliating adaptation rather than generic complaint." },
      { readReason: "identity_signal", angle: "Let class leak through one budgeting detail." },
    ],
  },
  street_art: {
    id: "street_art",
    label: "Street art",
    personaTags: ["street_art", "city_pride", "weird"],
    moments: [
      "A wall, tag, or mural changes meaning depending on where it is.",
      "The speaker notices street art colliding with cleanup, property, or memory.",
    ],
    angles: [
      { readReason: "weird_observation", angle: "Point to one piece that changed meaning because of its setting." },
      { readReason: "tenderness", angle: "Treat a local visual mark like a shared symbol." },
      { readReason: "microdrama", angle: "Let art and control quietly clash in the same space." },
    ],
  },
  sports_fan: {
    id: "sports_fan",
    label: "Sports fan",
    personaTags: ["sports", "overheard", "city_pride"],
    moments: [
      "A crowd, bar, train, or group chat swings emotionally in public.",
      "One fan sentence says more than the score itself.",
    ],
    angles: [
      { readReason: "overheard_truth", angle: "Use fan language that carries social life inside it." },
      { readReason: "identity_signal", angle: "Make the speaker recognizably from this city's fan culture." },
      { readReason: "microdrama", angle: "Capture one collective mood swing in one place." },
    ],
  },
  political_frustration: {
    id: "political_frustration",
    label: "Political frustration",
    personaTags: ["resentment", "identity", "work"],
    moments: [
      "Politics enters the speaker's day through inconvenience, jargon, or social exhaustion.",
      "The speaker is tired of being expected to perform the correct public feeling.",
    ],
    angles: [
      { readReason: "resentment", angle: "Keep it lived and practical, not policy-summary." },
      { readReason: "confession", angle: "Admit political fatigue without turning into apathy theater." },
      { readReason: "identity_signal", angle: "Show politics through a lived consequence, not a take." },
    ],
  },
  nostalgia: {
    id: "nostalgia",
    label: "Nostalgia",
    personaTags: ["nostalgia", "tenderness", "identity"],
    moments: [
      "The speaker notices one place, smell, or routine that no longer exists.",
      "The present accidentally brushes against an older version of the city.",
    ],
    angles: [
      { readReason: "tenderness", angle: "Use one missing place or habit with emotional weight." },
      { readReason: "identity_signal", angle: "Let memory reveal how long the speaker has been here." },
      { readReason: "resentment", angle: "Make the replacement sting more than the loss itself." },
    ],
  },
  random_encounter: {
    id: "random_encounter",
    label: "Random encounter",
    personaTags: ["weird", "microdrama", "tenderness"],
    moments: [
      "A stranger interacts with the speaker for ten seconds and leaves a mark.",
      "A city contact is too small to matter and still refuses to disappear from the speaker's head.",
    ],
    angles: [
      { readReason: "microdrama", angle: "Tiny contact with no full resolution." },
      { readReason: "tenderness", angle: "A stranger offers accidental care." },
      { readReason: "weird_observation", angle: "A stranger behaves in a way too strange to forget." },
    ],
  },
  city_pride: {
    id: "city_pride",
    label: "City pride",
    personaTags: ["local", "city_pride", "useful_local"],
    moments: [
      "The speaker defends one local habit or place without sounding like marketing.",
      "Pride appears through routine rather than slogan.",
    ],
    angles: [
      { readReason: "useful_local", angle: "Show a local thing outsiders underrate." },
      { readReason: "tenderness", angle: "Make pride emerge through a repeated ordinary pleasure." },
      { readReason: "identity_signal", angle: "Let the speaker sound loyal, specific, and mildly defensive." },
    ],
  },
  late_night_thought: {
    id: "late_night_thought",
    label: "Late-night thought",
    personaTags: ["late", "confession", "uncanny"],
    moments: [
      "The speaker is awake too late and suddenly honest in a way daytime would never allow.",
      "The city after a threshold hour changes what the speaker notices about themself.",
    ],
    angles: [
      { readReason: "confession", angle: "Lean into a lonely or repetitive self-truth." },
      { readReason: "weird_observation", angle: "Show one nocturnal behavior of the city that feels slightly off." },
      { readReason: "identity_signal", angle: "Reveal the speaker type through what keeps them awake." },
    ],
  },
  morning_ritual: {
    id: "morning_ritual",
    label: "Morning ritual",
    personaTags: ["morning", "identity", "tenderness"],
    moments: [
      "The speaker has a small routine that keeps them psychologically assembled.",
      "One morning habit reveals how they move through the city and who they are trying to be.",
    ],
    angles: [
      { readReason: "identity_signal", angle: "Let the ritual define the speaker without explicitly saying so." },
      { readReason: "useful_local", angle: "Build around a timing trick or route only locals know." },
      { readReason: "tenderness", angle: "Make the repetition itself feel quietly protective." },
    ],
  },
  humor: {
    id: "humor",
    label: "Dry humor",
    personaTags: ["weird", "overheard", "identity"],
    moments: [
      "The speaker notices something so absurd about city life that the only response is dry recognition.",
      "A small contradiction in how the city works becomes funnier the longer you look at it.",
    ],
    angles: [
      { readReason: "weird_observation", angle: "Let the observation be funny because of its precision, not its punchline." },
      { readReason: "microdrama", angle: "A minor social situation escalates to an absurd but recognizable outcome." },
      { readReason: "confession", angle: "The speaker is the joke — a habit or reaction they cannot explain." },
    ],
  },
  city_rumor: {
    id: "city_rumor",
    label: "City rumor",
    personaTags: ["local", "overheard", "microdrama"],
    moments: [
      "The speaker heard something they half-believe — a closure, a plan, a person — and cannot verify it.",
      "A piece of neighborhood gossip spreads the way only unconfirmed things do.",
    ],
    angles: [
      { readReason: "overheard_truth", angle: "Report an unverified local fact with exactly the right amount of doubt built in." },
      { readReason: "microdrama", angle: "The rumor creates a small social tension before it is even confirmed." },
      { readReason: "useful_local", angle: "Frame gossip as intelligence — something to act on, not just repeat." },
    ],
  },
  ai_anxiety: {
    id: "ai_anxiety",
    label: "AI in daily life",
    personaTags: ["work", "weird", "confession"],
    moments: [
      "The speaker uses an AI tool for something ordinary and feels quietly strange about it.",
      "Something the speaker encounters in the city turns out to be AI-generated and they cannot decide how to feel.",
    ],
    angles: [
      { readReason: "confession", angle: "Admit a small, non-dramatic way AI entered daily life without drama." },
      { readReason: "weird_observation", angle: "Notice one specific moment where AI-made and human-made things are indistinguishable." },
      { readReason: "identity_signal", angle: "Reveal the speaker's class, job, or generation through how they talk about AI." },
    ],
  },
  personal_story: {
    id: "personal_story",
    label: "Personal story",
    personaTags: ["confession", "microdrama", "identity"],
    moments: [
      "The speaker recalls one specific incident — a person, a place, a moment — that reveals something true about living in this city.",
      "Something happened recently that the speaker cannot stop thinking about. It involves a real person and a real place.",
    ],
    angles: [
      { readReason: "confession", angle: "First-person story: one specific event, one real detail that makes it feel true (a name, a street, a price, an exam). End with the thing you still think about, not a lesson." },
      { readReason: "microdrama", angle: "Short story with two characters and a moment of tension that resolves in an unexpected way. Keep it under 4 sentences." },
      { readReason: "weird_observation", angle: "A story that starts as a normal city situation and ends with the speaker realizing something they didn't expect. The twist is small and real, not cinematic." },
    ],
  },
};

export const mindPostFormats = {
  hot_take: {
    id: "hot_take",
    label: "Hot Take",
    description: "A sharp claim that reveals taste, irritation, and confidence.",
    promptShape: "The speaker opens with a debatable claim instead of a scene.",
    favoredReadReasons: ["resentment", "identity_signal", "confession"],
  },
  petty_manifesto: {
    id: "petty_manifesto",
    label: "Petty Manifesto",
    description: "A personal rule for surviving or judging city life.",
    promptShape: "The speaker states a tiny private rule as if it should be universal.",
    favoredReadReasons: ["identity_signal", "resentment", "useful_local"],
  },
  mini_theory: {
    id: "mini_theory",
    label: "Mini-Theory",
    description: "A personal theory about how the city really works.",
    promptShape: "The speaker proposes a theory built from repeated local pattern recognition.",
    favoredReadReasons: ["identity_signal", "weird_observation", "overheard_truth"],
  },
  social_diagnosis: {
    id: "social_diagnosis",
    label: "Social Diagnosis",
    description: "A bigger pattern is inferred from one everyday behavior.",
    promptShape: "The speaker uses one recurring public behavior to diagnose the city's psychology.",
    favoredReadReasons: ["resentment", "identity_signal", "microdrama"],
  },
  complaint_with_thesis: {
    id: "complaint_with_thesis",
    label: "Complaint With Thesis",
    description: "A complaint that leads to a stronger idea or accusation.",
    promptShape: "The speaker starts annoyed and lands on what the annoyance proves.",
    favoredReadReasons: ["resentment", "confession", "identity_signal"],
  },
  local_ranking: {
    id: "local_ranking",
    label: "Local Ranking",
    description: "A personal ranking that sounds arguable and revealing.",
    promptShape: "The speaker ranks city experiences in a way that exposes taste and values.",
    favoredReadReasons: ["identity_signal", "tenderness", "useful_local"],
  },
  false_romance_correction: {
    id: "false_romance_correction",
    label: "False Romance Correction",
    description: "Pushes back against a romanticized cliche about the city.",
    promptShape: "The speaker contrasts what people say the city is with what it actually feels like.",
    favoredReadReasons: ["resentment", "confession", "identity_signal"],
  },
  tiny_class_read: {
    id: "tiny_class_read",
    label: "Tiny Class Read",
    description: "Reads class or status from a tiny everyday choice.",
    promptShape: "The speaker reveals class or social category through one habit or preference.",
    favoredReadReasons: ["identity_signal", "resentment", "weird_observation"],
  },
  public_behavior_decoder: {
    id: "public_behavior_decoder",
    label: "Public Behavior Decoder",
    description: "Explains what a recurring public behavior actually means.",
    promptShape: "The speaker decodes a city behavior as if translating a local language.",
    favoredReadReasons: ["useful_local", "identity_signal", "overheard_truth"],
  },
  local_purity_test: {
    id: "local_purity_test",
    label: "Local Purity Test",
    description: "Defines a surprisingly specific sign of real localness.",
    promptShape: "The speaker sets a narrow, revealing criterion for who counts as local.",
    favoredReadReasons: ["identity_signal", "overheard_truth", "useful_local"],
  },
  reverse_envy: {
    id: "reverse_envy",
    label: "Reverse Envy",
    description: "The speaker envies a city type with uncomfortable honesty.",
    promptShape: "The speaker admits envy or resentment toward a specific local behavior or type.",
    favoredReadReasons: ["confession", "resentment", "identity_signal"],
  },
  moral_irritation: {
    id: "moral_irritation",
    label: "Moral Irritation",
    description: "A small annoyance is treated as morally revealing.",
    promptShape: "The speaker claims a tiny behavior exposes something bigger about people here.",
    favoredReadReasons: ["resentment", "microdrama", "identity_signal"],
  },
  urban_survival_logic: {
    id: "urban_survival_logic",
    label: "Urban Survival Logic",
    description: "An unofficial rule for staying sane in the city.",
    promptShape: "The speaker gives survival advice that sounds earned rather than inspirational.",
    favoredReadReasons: ["useful_local", "confession", "identity_signal"],
  },
  delayed_realization: {
    id: "delayed_realization",
    label: "Delayed Realization",
    description: "The speaker has just understood something about the city or themselves.",
    promptShape: "The speaker frames the post as a realization that arrived embarrassingly late.",
    favoredReadReasons: ["confession", "identity_signal", "resentment"],
  },
  overheard_analysis: {
    id: "overheard_analysis",
    label: "Overheard Analysis",
    description: "One line of public speech becomes a whole worldview.",
    promptShape: "The speaker quotes or paraphrases one line and spins a social truth out of it.",
    favoredReadReasons: ["overheard_truth", "microdrama", "identity_signal"],
  },
};

const topicIds = Object.keys(topics);
const cityById = new Map(cities.map((city) => [city.id, city]));
const personaById = new Map(personas.map((persona) => [persona.id, persona]));

export function listTopicIds() {
  return topicIds.slice();
}

export function listCityIds() {
  return cities.map((city) => city.id);
}

export function getTopic(topicId) {
  return topics[topicId];
}

export function getCity(cityId) {
  return cityById.get(cityId);
}

export function getPersona(personaId) {
  return personaById.get(personaId);
}

export function createSeededRandom(seedValue = "vortex-seed") {
  const seed = hashSeed(seedValue);
  return mulberry32(seed);
}

export function pickOne(items, rand) {
  return items[Math.floor(rand() * items.length)];
}

export function pickWeighted(items, rand, getWeight = (item) => item.weight ?? 1) {
  const total = items.reduce((sum, item) => sum + getWeight(item), 0);
  let roll = rand() * total;
  for (const item of items) {
    roll -= getWeight(item);
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

export function buildPrompt(job) {
  const city = getCity(job.cityId);
  const topic = getTopic(job.topicId);
  const reason = readReasons[job.readReason];
  const sourceProfile = sourceProfiles[job.sourceProfile];
  const tone = tones[job.tone];
  const lane = contentLanes[job.lane];
  const persona = getPersona(job.personaId);
  // Language priority: persona override > city persona override > weighted random from city distribution > fallback
  let languageGuidance;
  if (persona?.languageOverride) {
    languageGuidance = persona.languageOverride;
  } else if (city.personaLanguageOverrides?.[job.personaId]) {
    languageGuidance = city.personaLanguageOverrides[job.personaId];
  } else if (city.languageDistribution?.length) {
    const picked = pickWeighted(city.languageDistribution, Math.random);
    languageGuidance = picked.guidance;
  } else {
    languageGuidance = city.languageGuidance;
  }
  const laneInstructions =
    job.lane === "mind_post"
      ? [
          `Content lane: ${lane.label}. ${lane.guidance}`,
          `Mind-post format: ${job.formatLabel}. ${job.formatDescription}`,
          `Mind-post shape: ${job.formatPromptShape}`,
          "Write like someone thinking in public with a clear angle, not like a polished essay.",
          "A thesis, irritation, ranking, mini-theory, or diagnosis is welcome if it still feels like a person, not a pundit.",
        ]
      : [
          `Content lane: ${lane.label}. ${lane.guidance}`,
          "Write from a lived moment, observed fragment, overheard line, or small daily ritual.",
        ];

  return [
    "Write one short anonymous city message for Vortex.",
    `City: ${city.name}.`,
    `Language guidance: ${languageGuidance}`,
    ...laneInstructions,
    `Topic: ${topic.label}.`,
    `Read reason: ${reason.label} - ${reason.description}`,
    `Persona: ${job.personaLabel}. ${job.personaGuidance}`,
    `Scene angle: ${job.angle}`,
    `Moment: ${job.moment}`,
    `City anchor: ${job.cityAnchor}`,
    `Texture: ${job.textureGuidance}`,
    `Tone: ${tone.guidance}`,
    `Difficulty target: ${sourceProfile.guidance}`,
    ...(persona?.linkBehavior === "occasional"
      ? [
          "LINK REQUIRED: This persona shares real references. Your message MUST mention a specific place, venue, bar, restaurant, shop, street, station, or landmark by name. This naturally produces a Google Maps link in the links field. Think of it as: this person doesn't just observe — they name the exact spot. At least 80% of messages from this persona should reference a named location.",
        ]
      : []),
    "This message must be interesting even if there were no guessing mechanic.",
    `This seed will be stored in the game as source="${job.gameSource}". Do not mention that fact, but lean into the kind of ambiguity that makes that label debatable.`,
    "Do not summarize the city. Capture one moment, line, feeling, or irritation.",
    "Do not write like you are trying to represent the city well or cover its most obvious stereotypes.",
    "Use at most one iconic city marker in the content. Do not stack expected signals like rent + AI + driverless car + expensive coffee in one short text.",
    "Make the thought feel incidental and slightly arbitrary, like something a real person happened to say, not a neat example of local life.",
    "Do not ask the audience for advice, recommendations, neighborhood opinions, or moving help.",
    "Do not end with a tidy thesis, moral, metaphor, or reveal that explains the scene too well.",
    "Prefer a messier stop over a clever final sentence.",
    "Do not write urban poetry, postcard copy, or a polished mini-essay.",
    "No rhetorical questions and no clean little moral at the end.",
    "Avoid generic closers and avoid resolving the thought too perfectly.",
    "Make it plausible that a smart user could argue both human and AI.",
    "CRITICAL: The content field must be 60–240 characters. Do not exceed 240 characters. One to three sentences max.",
    "Return only JSON with keys: content, why_human, why_ai, read_value_hook, sentiment, detected_language.",
  ].join("\n");
}

export function getTopicAngles(topicId) {
  return topics[topicId].angles.slice();
}

export function getMindPostFormats() {
  return Object.values(mindPostFormats);
}

export function getCompatiblePersonas(topicId, cityId) {
  const topic = getTopic(topicId);
  const city = getCity(cityId);
  const weighted = personas
    .filter((persona) => !persona.cityOnly || persona.cityOnly === cityId)
    .map((persona) => {
      let weight = 1;
      if (city.personaBias.includes(persona.id)) weight += 2.5;
      if (topic.personaTags.some((tag) => persona.tags.includes(tag))) weight += 2;
      return { persona, weight };
    });
  return weighted;
}

export function getCompatibleTextures(sourceProfileId) {
  return textures.filter((texture) => texture.fits.includes(sourceProfileId));
}

export function getTopicAnchor(cityId, topicId, rand) {
  const city = getCity(cityId);
  const anchors = city.topicAnchors[topicId] ?? city.defaultAnchors;
  return pickOne(anchors, rand);
}

export function getTopicMoment(topicId, rand) {
  return pickOne(getTopic(topicId).moments, rand);
}

export function allKnownCityAnchors() {
  return cities.flatMap((city) => [
    ...city.defaultAnchors,
    ...Object.values(city.topicAnchors).flat(),
  ]);
}

function hashSeed(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
