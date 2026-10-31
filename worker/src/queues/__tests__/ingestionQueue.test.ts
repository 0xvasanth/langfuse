import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Job } from "bullmq";
import {
  getS3EventStorageClient,
  hasS3SlowdownFlag,
  markProjectIngestFailure,
  markProjectS3Slowdown,
  type QueueName,
  StorageServiceFactory,
  type TQueueJobTypes,
} from "@langfuse/shared/src/server";
import { env } from "../../env";
import { ingestionQueueProcessorBuilder } from "../ingestionQueue";

const { fakeRedis, mergeAndWrite, seenKeys } = vi.hoisted(() => {
  const seenKeys = new Set<string>();
  return {
    seenKeys,
    mergeAndWrite: vi.fn(),
    fakeRedis: {
      exists: vi.fn(async (key: string) => (seenKeys.has(key) ? 1 : 0)),
      set: vi.fn(async (key: string) => {
        seenKeys.add(key);
        return "OK";
      }),
    },
  };
});

vi.mock("@langfuse/shared/src/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langfuse/shared/src/server")>()),
  clickhouseClient: vi.fn(),
  getS3EventStorageClient: vi.fn(),
  hasS3SlowdownFlag: vi.fn(),
  markProjectS3Slowdown: vi.fn(),
  markProjectIngestFailure: vi.fn(),
  redis: fakeRedis,
}));

vi.mock("../../services/ClickhouseWriter", () => ({
  ClickhouseWriter: { getInstance: vi.fn(() => ({ addToQueue: vi.fn() })) },
  TableName: {},
}));

vi.mock("../../services/IngestionService", () => ({
  IngestionService: vi.fn(function () {
    return { mergeAndWrite };
  }),
}));

const projectId = "slowdown-project";

const ingestionJob = {
  data: {
    id: "job-1",
    timestamp: new Date(),
    name: "ingestion-job",
    payload: {
      authCheck: {
        validKey: true,
        scope: { projectId, accessLevel: "project" },
      },
      data: {
        type: "trace-create",
        eventBodyId: "trace-1",
        fileKey: "file-1",
        skipS3List: true,
      },
    },
  },
  attemptsMade: 0,
  opts: { attempts: 5 },
} as unknown as Job<TQueueJobTypes[QueueName.IngestionQueue]>;

describe("ingestion queue S3 SlowDown handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasS3SlowdownFlag).mockResolvedValue(false);

    const storage = StorageServiceFactory.getInstance({
      bucketName: "events",
      accessKeyId: "test",
      secretAccessKey: "test",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:1",
      forcePathStyle: true,
      useAzureBlob: false,
      useGoogleCloudStorage: false,
    });
    const slowDown = Object.assign(
      new Error("Please reduce your request rate."),
      { name: "SlowDown", Code: "SlowDown" },
    );
    vi.spyOn(
      (storage as unknown as { client: { send: () => Promise<unknown> } })
        .client,
      "send",
    ).mockRejectedValue(slowDown);
    vi.mocked(getS3EventStorageClient).mockReturnValue(storage);
  });

  it("marks the project for the secondary queue when the storage client wraps a SlowDown", async () => {
    const processor = ingestionQueueProcessorBuilder(true);

    await expect(processor(ingestionJob)).rejects.toThrow(
      "Failed to download file from S3",
    );

    expect(markProjectS3Slowdown).toHaveBeenCalledWith(projectId);
    expect(markProjectIngestFailure).toHaveBeenCalledWith(projectId, {
      source: "ingestion_queue",
      reason: "s3_slowdown",
    });
  });
});

describe("ingestion queue seen-event cache", () => {
  const bucketPrefix = `${projectId}/observation/span-1/`;
  const originalCacheSetting = env.LANGFUSE_ENABLE_REDIS_SEEN_EVENT_CACHE;

  const storage = { listFiles: vi.fn(), download: vi.fn() };

  const listedFiles = (...eventIds: string[]) =>
    eventIds.map((eventId) => ({
      file: `${bucketPrefix}${eventId}.json`,
      createdAt: new Date(),
    }));

  const jobFor = (eventId: string, skipS3List = false) =>
    ({
      ...ingestionJob,
      data: {
        ...ingestionJob.data,
        payload: {
          ...ingestionJob.data.payload,
          data: {
            type: "span-create",
            eventBodyId: "span-1",
            fileKey: eventId,
            bucketPrefix,
            skipS3List,
          },
        },
      },
    }) as Job<TQueueJobTypes[QueueName.IngestionQueue]>;

  const mergedEventIds = (call: number) =>
    mergeAndWrite.mock.calls[call][0].events.map(
      (event: { id: string }) => event.id,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    storage.listFiles.mockReset();
    seenKeys.clear();
    env.LANGFUSE_ENABLE_REDIS_SEEN_EVENT_CACHE = "true";
    vi.mocked(hasS3SlowdownFlag).mockResolvedValue(false);
    vi.mocked(getS3EventStorageClient).mockReturnValue(
      storage as unknown as ReturnType<typeof getS3EventStorageClient>,
    );
    storage.download.mockImplementation(async (path: string) => {
      const id = path.slice(bucketPrefix.length, -".json".length);
      return JSON.stringify([
        { id, type: "span-create", body: { id: "span-1" } },
      ]);
    });
  });

  afterEach(() => {
    env.LANGFUSE_ENABLE_REDIS_SEEN_EVENT_CACHE = originalCacheSetting;
  });

  it("processes a distinct event whose id only differs by where .json sits", async () => {
    const processor = ingestionQueueProcessorBuilder(true);

    // The first job lists the prefix before the second file is visible, so
    // the second event is only picked up if its own job runs.
    storage.listFiles.mockResolvedValueOnce(listedFiles("a.json.b"));
    await processor(jobFor("a.json.b"));

    storage.listFiles.mockResolvedValueOnce(
      listedFiles("a.json.b", "a.b.json"),
    );
    await processor(jobFor("a.b.json"));

    expect(mergeAndWrite).toHaveBeenCalledTimes(2);
    expect(mergedEventIds(1)).toEqual(["a.json.b", "a.b.json"]);
  });

  it.each([
    { eventId: "event-1", skipS3List: false },
    { eventId: "a.json.b", skipS3List: false },
    { eventId: "a.b.json", skipS3List: false },
    { eventId: "a.json.b", skipS3List: true },
  ])(
    "skips a re-delivered file for event $eventId (skipS3List: $skipS3List)",
    async ({ eventId, skipS3List }) => {
      const processor = ingestionQueueProcessorBuilder(true);
      storage.listFiles.mockResolvedValue(listedFiles(eventId));

      await processor(jobFor(eventId, skipS3List));
      await processor(jobFor(eventId, skipS3List));

      expect(mergeAndWrite).toHaveBeenCalledTimes(1);
      expect(mergedEventIds(0)).toEqual([eventId]);
    },
  );

  it("reprocesses re-delivered files without touching Redis when disabled", async () => {
    env.LANGFUSE_ENABLE_REDIS_SEEN_EVENT_CACHE = "false";
    const processor = ingestionQueueProcessorBuilder(true);
    storage.listFiles.mockResolvedValue(listedFiles("event-1"));

    await processor(jobFor("event-1"));
    await processor(jobFor("event-1"));

    expect(mergeAndWrite).toHaveBeenCalledTimes(2);
    expect(fakeRedis.exists).not.toHaveBeenCalled();
    expect(fakeRedis.set).not.toHaveBeenCalled();
  });
});
