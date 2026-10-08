import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { docksideRpcContract } from "@/server";
import { useRetryingRead } from "@/hooks/use-retrying-read";
import { TURN_CHANNEL, type TurnTimes } from "@/lib/turn-sections";

type TurnChange = TurnTimes | { threadId: string; deleted: true };

/** Latest turn start and end per thread, kept live over realtime. */
export function useTurnTimes(): ReadonlyMap<string, TurnTimes> {
  const rpc = useRpc<typeof docksideRpcContract>();
  const [turns, setTurns] = useState<ReadonlyMap<string, TurnTimes>>(
    () => new Map(),
  );
  const requestSequence = useRef(0);

  const read = useCallback(async () => {
    const sequence = ++requestSequence.current;
    const result = await rpc.call("listTurns", {});
    if (sequence !== requestSequence.current) return;
    setTurns(new Map(result.turns.map((turn) => [turn.threadId, turn])));
  }, [rpc]);
  const refresh = useRetryingRead(read);

  useEffect(() => refresh(), [refresh]);

  useRealtime(TURN_CHANNEL, (payload) => {
    const change = payload as TurnChange;
    if (typeof change?.threadId !== "string") return;
    setTurns((current) => {
      const next = new Map(current);
      if ("deleted" in change) next.delete(change.threadId);
      else next.set(change.threadId, change);
      return next;
    });
  });

  // Changes published while the connection was down are gone; read again.
  const connectionState = useRealtimeConnectionState();
  const previousConnectionState = useRef(connectionState);
  useEffect(() => {
    const previous = previousConnectionState.current;
    previousConnectionState.current = connectionState;
    if (previous === "reconnecting" && connectionState === "connected") {
      refresh();
    }
  }, [connectionState, refresh]);

  return turns;
}
