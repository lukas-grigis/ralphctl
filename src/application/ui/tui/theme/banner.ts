/**
 * Banner ASCII art + Ralph quote pool. The {@link Banner} component (in `components/banner.tsx`) renders this through
 * the inline gradient.
 */

const BANNER = `
     ██████╗  █████╗ ██╗     ██████╗ ██╗  ██╗ ██████╗████████╗██╗
     ██╔══██╗██╔══██╗██║     ██╔══██╗██║  ██║██╔════╝╚══██╔══╝██║
     ██████╔╝███████║██║     ██████╔╝███████║██║        ██║   ██║
     ██╔══██╗██╔══██║██║     ██╔═══╝ ██╔══██║██║        ██║   ██║
     ██║  ██║██║  ██║███████╗██║     ██║  ██║╚██████╗   ██║   ███████╗
     ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝ ╚═════╝   ╚═╝   ╚══════╝
`;

export const banner = {
  art: BANNER,
  tagline: "I'm helping with your sprints!",
} as const;

const RALPH_QUOTES = [
  "I'm helping!",
  "Me fail English? That's unpossible!",
  'Go banana!',
  'Hi, Super Nintendo Chalmers!',
  'I bent my wookie.',
  "My cat's breath smells like cat food.",
  "I'm learnding!",
  'I found a moonrock in my nose!',
  "That's where I saw the leprechaun. He told me to burn things.",
  "My daddy's gonna put you in jail!",
  "I'm a unitard!",
  'I ate the purple berries...',
  'Tastes like burning!',
  "My parents won't let me use scissors.",
  'I dress myself!',
  "I'm Idaho!",
  'Even my boogers are spicy!',
  'It smells like hot dogs.',
  'I sleep in a drawer!',
  'I picked the red one!',
  'The pointy kitty took it!',
  'When I grow up, I want to be a principal or a caterpillar.',
] as const;

export const getRandomQuote = (): string => {
  const i = Math.floor(Math.random() * RALPH_QUOTES.length);
  return RALPH_QUOTES[i] ?? '';
};
