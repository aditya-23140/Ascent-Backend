import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- Cleaning up duplicate users ---');
  
  const users = await prisma.user.findMany();
  const seenClerkIds = new Set();
  const duplicates = [];

  for (const user of users) {
    if (seenClerkIds.has(user.clerkId)) {
      duplicates.push(user.id);
    } else {
      seenClerkIds.add(user.clerkId);
    }
  }

  if (duplicates.length > 0) {
    console.log(`Found ${duplicates.length} duplicate(s). Deleting...`);
    await prisma.user.deleteMany({
      where: {
        id: { in: duplicates }
      }
    });
    console.log('Duplicates deleted.');
  } else {
    console.log('No duplicates found.');
  }

  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
