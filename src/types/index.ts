
export interface Subtask {
  id: string;
  title: string;
  duration: number;
  actualDuration?: number | null;
  completed: boolean;
  completedAt?: Date | null;
  position: number;
  taskId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Task {
  id: string;
  title: string;
  description?: string | null;
  priority: string;
  status: string;
  deadline?: Date | null;
  completed: boolean;
  position: number;
  userId: string;
  subtasks?: Subtask[];
  createdAt: Date;
  updatedAt: Date;
}

export interface RewardToken {
  id: string;
  studentId: string;
  balance: number;
  lifetimeEarned: number;
}

export interface RewardItem {
  id: string;
  parentId: string;
  name: string;
  description?: string | null;
  tokenCost: number;
  category: string;
}

export interface RedemptionRequest {
  id: string;
  studentId: string;
  rewardItemId: string;
  rewardItem: RewardItem;
  status: string;
  requestedAt: Date;
  resolvedAt?: Date | null;
}

export interface SpoonLog {
  id: string;
  userId: string;
  date: string;
  spoonsUsed: number;
  effortMultiplier: number;
  pulsesApplied: string[];
  createdAt: Date;
}

export interface User {
  id: string;
  clerkId: string;
  email?: string | null;
  name?: string | null;
  points: number;
  level: number;
  role: string;
  parentId?: string | null;
  currentStreak: number;
  rewardTokens?: RewardToken | null;
  redemptionRequests?: RedemptionRequest[];
  spoonLogs?: SpoonLog[];
}

export interface ChildWithRewards extends User {
  rewardTokens: RewardToken | null;
  redemptionRequests: RedemptionRequest[];
  spoonLogs: SpoonLog[];
}
