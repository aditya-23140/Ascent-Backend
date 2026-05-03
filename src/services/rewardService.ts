import { prisma } from '../lib/prisma';

class RewardService {
  /**
   * Awards tokens to a student based on XP earned.
   * Rate: 1 token per 10 XP.
   */
  async awardTokens(studentId: string, xpEarned: number) {
    const tokensToEarn = Math.floor(xpEarned / 10);
    if (tokensToEarn <= 0) return;

    await prisma.rewardToken.upsert({
      where: { studentId },
      update: {
        balance: { increment: tokensToEarn },
        lifetimeEarned: { increment: tokensToEarn }
      },
      create: {
        studentId,
        balance: tokensToEarn,
        lifetimeEarned: tokensToEarn
      }
    });
  }

  /**
   * Processes a redemption request using User.points.
   */
  async requestRedemption(studentId: string, rewardItemId: string) {
    const reward = await prisma.rewardItem.findUnique({
      where: { id: rewardItemId }
    });

    if (!reward) throw new Error('Reward item not found');

    const user = await prisma.user.findUnique({
      where: { id: studentId }
    });

    if (!user || user.points < reward.tokenCost) {
      throw new Error('Insufficient points');
    }

    // Deduct points and create request
    await prisma.$transaction([
      prisma.user.update({
        where: { id: studentId },
        data: { points: { decrement: reward.tokenCost } }
      }),
      prisma.redemptionRequest.create({
        data: {
          studentId,
          rewardItemId,
          status: 'PENDING'
        }
      })
    ]);
  }

  /**
   * Parent approves or rejects a request.
   */
  async resolveRequest(requestId: string, parentId: string, approve: boolean) {
    const request = await prisma.redemptionRequest.findUnique({
      where: { id: requestId },
      include: { rewardItem: true }
    });

    if (!request) throw new Error('Request not found');
    if (request.rewardItem.parentId !== parentId) throw new Error('Unauthorized');

    if (approve) {
      await prisma.redemptionRequest.update({
        where: { id: requestId },
        data: {
          status: 'APPROVED',
          resolvedAt: new Date()
        }
      });
    } else {
      // Refund points if rejected
      await prisma.$transaction([
        prisma.user.update({
          where: { id: request.studentId },
          data: { points: { increment: request.rewardItem.tokenCost } }
        }),
        prisma.redemptionRequest.update({
          where: { id: requestId },
          data: {
            status: 'REJECTED',
            resolvedAt: new Date()
          }
        })
      ]);
    }
  }

  /**
   * Link a student to a parent.
   */
  async linkStudent(studentId: string, parentId: string) {
    await prisma.user.update({
      where: { id: studentId },
      data: { parentId }
    });
  }
}

export const rewardService = new RewardService();
