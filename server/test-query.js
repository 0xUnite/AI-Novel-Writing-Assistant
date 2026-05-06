const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.novelReviewBatchJob.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 1
  });
  console.log(JSON.stringify(jobs, null, 2));
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
