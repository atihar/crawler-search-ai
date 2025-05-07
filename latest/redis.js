import { Redis } from '@upstash/redis';
import { v4 as uuidv4 } from 'uuid';

// Initialize Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Add multiple URLs to the discovered list (Redis Set)
export async function addUrlsToCrawl(urls) {
  console.log(`Adding ${urls.length} URLs to crawl`);
  await redis.sadd('urls:to_crawl', ...urls);  // Add multiple URLs at once
}

// Get discovered URLs to crawl (returns an array)
export async function getUrlsToCrawl() {
  console.log('Fetching discovered URLs...');
  return await redis.smembers('urls:to_crawl'); // Fetch all URLs from the Redis set
}

// Mark a URL as visited with a timestamp
export async function markUrlVisited(url) {
  const timestamp = Date.now();
  await redis.hset('urls:visited', url, timestamp.toString());
}

// Check if URL was visited within the last 6 hours
export async function canCrawlUrl(url) {
  const timestamp = await redis.hget('urls:visited', url);
  if (!timestamp) return true; // Not visited before, can crawl

  const lastVisited = parseInt(timestamp, 10);
  const sixHours = 6 * 60 * 60 * 1000; // 6 hours in milliseconds
  return Date.now() - lastVisited > sixHours;
}

// Store or update a crawled page in the search index
export async function saveToSearchIndex(crawlId, document) {
    const documentId = uuidv4();  // Generate a new unique ID using UUID
    const existingDoc = await redis.get(`index:${documentId}`);
  
    // Ensure the document is stringified before saving it to Redis
    const documentJson = JSON.stringify(document); // Stringify the document
  
    if (existingDoc) {
      // If the document exists, update it
      console.log(`Updating document for ${documentId}`);
      await redis.set(`index:${documentId}`, documentJson);  // Store the stringified document
    } else {
      // Otherwise, add the new document
      console.log(`Adding new document for ${documentId}`);
      await redis.set(`index:${documentId}`, documentJson);  // Store the stringified document
    }
  }

// Initialize URLs with main URL
export async function initializeUrls(mainUrl) {
  try {
    console.log('Initializing urls:to_crawl');
    
    // Check the type of the current key in Redis
    const keyType = await redis.type('urls:to_crawl');
    if (keyType !== 'set') {
      console.log('Resetting urls:to_crawl because the type is incorrect:', keyType);
      await redis.del('urls:to_crawl');  // Delete the existing key if it's the wrong type
    }

    // Ensure the main URL is added to the set
    const exists = await redis.sismember('urls:to_crawl', mainUrl); // Check if the URL is already in the set
    if (!exists) {
      await redis.sadd('urls:to_crawl', mainUrl);  // Add the main URL to the set
      console.log('Initialized urls:to_crawl with main URL:', mainUrl);
    } else {
      console.log('Main URL already in urls:to_crawl:', mainUrl);
    }
  } catch (error) {
    console.error('Error initializing URLs:', error.message);
    const initialUrls = [mainUrl];
    await redis.sadd('urls:to_crawl', ...initialUrls);  // Add the main URL to the set as fallback
    console.log('Initialized urls:to_crawl with fallback:', initialUrls);
  }
}

// Safely parse JSON
export function parseJson(data, fallback) {
  try {
    if (typeof data === 'object' && Array.isArray(data)) {
      return data;
    }
    if (typeof data === 'string') {
      return JSON.parse(data);
    }
    throw new Error('Invalid data type for parsing');
  } catch (error) {
    console.error('JSON parse error:', error.message, 'Raw data:', data);
    return fallback;
  }
}

export { redis };
