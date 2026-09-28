/**
 * Feed query families for X discovery (LOL-36 Stage A).
 * 
 * These are curated search operator strings targeting educational tools,
 * schools, curricula, and related discussions on X/Twitter.
 * 
 * Each family targets a specific intent as defined by LOL-33 directive 3:
 * "all modern interesting educational tools, schools and curricula people
 * discussing on X end up in our marketplace."
 */

import type { FeedQuery } from "./types.js";

export const QUERY_FAMILIES: FeedQuery[] = [
  // ── EdTech Product Launches ──────────────────────────────────────────
  {
    family: "edtech_launches",
    query: '(#edtech OR #EdTech) (#launch OR #new OR #announce) -is:retweet',
    description: "New edtech product announcements with engagement",
  },
  {
    family: "app_launches",
    query: '"new app" (education OR teaching OR learning OR school) -is:retweet',
    description: "App store launch announcements for education apps",
  },
  {
    family: "product_hunt_edu",
    query: 'from:producthunt (education OR curriculum OR classroom OR homework) -is:retweet',
    description: "Product Hunt posts about education products",
  },
  // ── Homeschool Curricula ─────────────────────────────────────────────
  {
    family: "homeschool_curricula",
    query: '(homeschool OR homeschooling) (curriculum OR program OR resources OR materials) -is:retweet',
    description: "Discussion of homeschool curriculum resources",
  },
  {
    family: "unschooling_resources",
    query: '(unschooling OR unschooler) (resource OR book OR program OR tool) -is:retweet',
    description: "Unschooling resource recommendations",
  },
  // ── Gifted / Acceleration ───────────────────────────────────────────
  {
    family: "gifted_programs",
    query: '(gifted OR acceleration OR advanced) (program OR competition OR course OR Olympiad) education -is:retweet',
    description: "Gifted education programs and competitions",
  },
  {
    family: "math_competition",
    query: '(Mathcounts OR AMC8 OR AMC10 OR Math_Olympiad OR "Beast Academy" OR "Art of Problem Solving") -is:retweet',
    description: "Math competition and prep program mentions",
  },
  // ── Phonics / Reading Programs ───────────────────────────────────────
  {
    family: "phonics_reading",
    query: '(phonics OR Orton-Gillingham OR AllAboutReading OR WeightedWords) -is:retweet',
    description: "Phonics-based reading instruction programs",
  },
  {
    family: "reading_intervention",
    query: '(reading intervention OR guided reading OR FountasPinnell OR DIBELS) -is:retweet',
    description: "Reading intervention and assessment programs",
  },
  // ── STEAM / STEM Tools ──────────────────────────────────────────────
  {
    family: "stem_steam",
    query: '(STEM OR STEAM) (robotics kit OR coding OR circuit OR science experiment) kids -is:retweet',
    description: "STEM/STEAM hands-on learning kits and tools",
  },
  {
    family: "coding_kids",
    query: '(coding OR programming OR Scratch OR Blockly OR microbit OR Arduino) (kids OR children OR elementary) -is:retweet',
    description: "Coding/programming tools for young learners",
  },
  // ── Alternative Schools ─────────────────────────────────────────────
  {
    family: "alternative_schools",
    query: '(Montessori OR Waldorf OR Sudbury OR democratic OR project-based learning) school -is:retweet',
    description: "Alternative education models and schools",
  },
  {
    family: "microschools",
    query: '(microschool OR micro-school OR homeschool collective OR pod) -is:retweet',
    description: "Microschool and learning pod networks",
  },
  // ── Special Education / Assistive Tech ───────────────────────────────
  {
    family: "assistive_tech",
    query: '(assistive technology OR AAC OR PECS OR speech therapy app OR dyslexia tool OR IEP tool) -is:retweet',
    description: "Assistive technology and special education tools",
  },
  {
    family: "sensory_tools",
    query: '(sensory OR occupational therapy OR proprioceptive OR regulation) (tool OR activity OR classroom) -is:retweet',
    description: "Sensory integration and OT resources for classrooms",
  },
  // ── Parent Discussion Clusters ───────────────────────────────────────
  {
    family: "parent_recommendations",
    query: '(parent OR mom OR dad) recommend(ed OR s) (app OR program OR curriculum OR website OR tool) (kid OR child OR student) -is:retweet',
    description: "Parent recommendation threads for learning tools",
  },
  {
    family: "teacher_sharing",
    query: '(teacher) share(d OR s) (activity OR resource OR lesson OR template OR worksheet OR toolkit) (free OR paid) -is:retweet',
    description: "Teacher sharing actual teaching materials/resources",
  },
];

/** Total queries available across all families. */
export const TOTAL_QUERY_COUNT = QUERY_FAMILIES.length;
