import { input, select } from '@inquirer/prompts';
import { highlight, info, muted, success } from '@src/utils/colors.ts';

export async function helloCommand(): Promise<void> {
  console.log(info('\n👋 Welcome to the hello command!\n'));

  const name = await input({
    message: 'What is your name?',
    default: 'World',
  });

  const greeting = await select({
    message: 'How should I greet you?',
    choices: [
      { name: 'Formal', value: 'formal', description: 'A professional greeting' },
      { name: 'Casual', value: 'casual', description: 'A friendly greeting' },
      { name: 'Enthusiastic', value: 'enthusiastic', description: 'An excited greeting' },
    ],
  });

  console.log();

  switch (greeting) {
    case 'formal':
      console.log(success(`Good day, ${highlight(name)}. It is a pleasure to meet you.`));
      break;
    case 'casual':
      console.log(success(`Hey ${highlight(name)}! Nice to meet you.`));
      break;
    case 'enthusiastic':
      console.log(success(`🎉 WOW! ${highlight(name)}! SO GREAT TO MEET YOU! 🎉`));
      break;
  }

  console.log(muted('\nThanks for trying out ralphctl!\n'));
}
