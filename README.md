# Ascent Backend - Memory Optimized

Node.js (TypeScript) backend for the Ascent productivity suite. Optimized for low RAM usage and hardware compatibility.

## Tech Stack
- **Runtime**: Node.js (TypeScript)
- **Database**: MongoDB via Prisma
- **Auth**: Clerk (Web) & Hashed Device Tokens (ESP32)
- **Real-time**: Native WebSockets (`ws`)
- **Validation**: Zod

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Environment Variables**:
   Create a `.env` file with:
   ```env
   DATABASE_URL="mongodb+srv://..."
   CLERK_SECRET_KEY="sk_test_..."
   PORT=5000
   ```

3. **Database Schema**:
   ```bash
   npx prisma generate
   ```

4. **Run development server**:
   ```bash
   npm run dev
   ```

## WebSocket Protocol (for ESP32/Web)

### Connection
Connect to `ws://localhost:5000?token=YOUR_TOKEN`

### Incoming Messages (Actions)
Send JSON to trigger actions:
```json
{ "action": "start", "duration": 1500, "taskId": "...", "phase": "work" }
{ "action": "pause" }
{ "action": "resume" }
{ "action": "skip" }
```

### Outgoing Messages (Broadcasts)
The server broadcasts state updates:
```json
{
  "type": "timer_update",
  "payload": {
    "phase": "work",
    "remainingSeconds": 1495,
    "taskId": "..."
  }
}
```

## RAM Saving Features
- **Native WS**: Reduces idle memory by ~60% compared to Socket.io.
- **SetInterval Cleanup**: Timers only run when active.
- **Connection Mapping**: Automatic Map cleanup when users disconnect.
