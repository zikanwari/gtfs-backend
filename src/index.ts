import express from 'express';
import cors from 'cors';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Load gtfs mapping
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mappingPath = path.join(__dirname, 'gtfs-mapping.json');
const mappingData = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));

const geiyoMappingPath = path.join(__dirname, 'gtfs-mapping-geiyo.json');
const geiyoMappingData = JSON.parse(fs.readFileSync(geiyoMappingPath, 'utf8'));

type GtfsSource = {
    url: string;
    mapping: Record<string, Record<string, string>>;
};

const sources: GtfsSource[] = [
    {
        url: 'https://ajt-mobusta-gtfs.mcapps.jp/realtime/15/trip_updates.bin',
        mapping: mappingData,
    },
    { url: 'https://ajt-mobusta-gtfs.mcapps.jp/realtime/11/trip_updates.bin',
        mapping: geiyoMappingData
    },
];
const CACHE_TTL_MS = 15_000;

type DelayCacheEntry = {
    fetchedAt: number;
    data: Record<string, Record<string, number>>;
};

const app = express();
app.use(cors()); // Allow all origins

let delayCache: DelayCacheEntry | null = null;

async function fetchDelays(): Promise<Record<string, Record<string, number>>> {
    const allDelays: Record<string, Record<string, number>> = {};

    const fetchPromises = sources.map(async (source) => {
        const response = await fetch(source.url);
        if (!response.ok) {
            // 1つのソースで失敗しても、他のソースの処理は続行するため、エラーをログに出力して空のオブジェクトを返す
            console.error(`Failed to fetch GTFS data from ${source.url}: ${response.status}`);
            return;
        }

        const buffer = await response.arrayBuffer();
        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

        for (const entity of feed.entity) {
            if (!entity.tripUpdate || !entity.tripUpdate.stopTimeUpdate) continue;

            const tripId = entity.tripUpdate.trip.tripId;
            if (!tripId) continue;

            for (const update of entity.tripUpdate.stopTimeUpdate) {
                const stopId = update.stopId;
                if (!stopId) continue;

                const mappingInfo = source.mapping[tripId];
                if (!mappingInfo) continue;

                const scheduledTimeRaw = mappingInfo[stopId];
                if (!scheduledTimeRaw) continue;

                const delay = update.departure?.delay ?? update.arrival?.delay;
                if (delay === undefined || delay === null) continue;

                const scheduledTime = scheduledTimeRaw.split(':').slice(0, 2).join(':');
                if (!scheduledTime) continue;

                // GTFSのstopId（例: "40010 1"）からプレフィックス部分（"40010"）を抽出
                // フロントエンド側はこのプレフィックスをキーとして遅延情報を参照する
                const stopPrefix = stopId.split(' ')[0];

                if (!allDelays[stopPrefix]) {
                    allDelays[stopPrefix] = {};
                }

                allDelays[stopPrefix][scheduledTime] = delay;
            }
        }
    });

    await Promise.all(fetchPromises);
    return allDelays;
}

app.get('/api/delays', async (req, res) => {
    try {
        const now = Date.now();
        if (delayCache && now - delayCache.fetchedAt < CACHE_TTL_MS) {
            return res.json(delayCache.data);
        }

        const delays = await fetchDelays();
        if (Object.keys(delays).length > 0) {
            delayCache = {
                fetchedAt: now,
                data: delays,
            };
            return res.json(delays);
        }

        if (delayCache) {
            console.warn('Fetched empty delay data; serving last cached response instead.');
            return res.json(delayCache.data);
        }

        res.json(delays);
    } catch (error) {
        if (delayCache) {
            console.warn('Fetch failed; serving last cached response instead.');
            return res.json(delayCache.data);
        }

        console.error('Error fetching GTFS realtime data:', error);
        res.status(500).json({ error: 'Failed to fetch data' });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
