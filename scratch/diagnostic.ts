import { prisma } from '../src/lib/prisma';

async function diagnose() {
  const taskId = '69e903ab5aa662a10bd752de';
  
  console.log('--- DIAGNOSTIC START ---');
  
  // 1. Check Task
  const task = await prisma.task.findUnique({
    where: { id: taskId }
  });
  
  if (task) {
    console.log(`Task Found: "${task.title}"`);
    console.log(`Task Owner (userId): ${task.userId}`);
  } else {
    console.log(`Task NOT FOUND in DB: ${taskId}`);
  }
  
  // 2. Check current users
  const users = await prisma.user.findMany();
  console.log(`\nTotal Users in DB: ${users.length}`);
  users.forEach(u => {
    console.log(`- User: ${u.id} (Clerk: ${u.clerkId})`);
  });
  
  console.log('--- DIAGNOSTIC END ---');
  process.exit(0);
}

diagnose();
