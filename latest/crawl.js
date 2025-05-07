import * as cheerio from 'cheerio';
import MiniSearch from 'minisearch';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { redis, addUrlsToCrawl, getUrlsToCrawl, canCrawlUrl, markUrlVisited, saveToSearchIndex, initializeUrls } from '@/lib/redis';

export const maxDuration = 300;

// Crawling configuration
const MAIN_URL = 'https://idemitsu-lubricants-staging.webflow.io'; // Your starting URL
const MAX_PAGES = 10; // Limit the number of pages to crawl per batch
const CRAWL_DELAY_MS = 1500; // Delay between requests

export async function POST() {
  try {
    const crawlId = uuidv4();
    const normalizedMainUrl = MAIN_URL.replace(/\/$/, '');
    const origin = new URL(normalizedMainUrl).origin;

    // Initialize URLs in Redis
    await initializeUrls(normalizedMainUrl);

    // Get discovered URLs to crawl (limit to 20 URLs for the current invocation)
    let urlsToCrawl = await getUrlsToCrawl();
    console.log('Fetched URLs to crawl:', urlsToCrawl);

    // If no URLs to crawl, exit early
    if (urlsToCrawl.length === 0) {
      console.log('No URLs to crawl, exiting...');
      return NextResponse.json({ error: 'No URLs to crawl' }, { status: 400 });
    }

    // Limit the batch size (20 URLs per batch)
    const batchSize = 20;
    urlsToCrawl = urlsToCrawl.slice(0, batchSize); // Take only the first batch

    console.log(`Processing ${urlsToCrawl.length} URLs...`);

    let crawledUrls = [];
    let id = 1;

    const miniSearch = new MiniSearch({
      fields: ['title', 'content'],
      storeFields: ['title', 'url', 'depth'],
    });

    // Determine the path to Chromium
    let executablePath;
    const isVercel = process.env.VERCEL === '1'; // Check if we're running on Vercel

    if (isVercel) {
      // Use the path provided by @sparticuz/chromium for Vercel
      executablePath = await chromium.executablePath();
    } else {
      // Use local Chromium installation for local development
      executablePath = process.env.LOCAL_CHROMIUM_PATH ||
        '/Applications/Chromium.app/Contents/MacOS/Chromium' ||
        '/opt/homebrew/bin/chromium';
    }

    // Check if Chromium path exists (for local development)
    const fs = require('fs');
    if (!fs.existsSync(executablePath)) {
      throw new Error(`Chromium binary not found at ${executablePath}. Please install Chromium or set LOCAL_CHROMIUM_PATH.`);
    }

    // Launch Puppeteer with the correct executable path
    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: isVercel ? chromium.args : ['--no-sandbox', '--disable-setuid-sandbox'],
    }).catch((error) => {
      console.error('Failed to launch browser:', error.message);
      throw new Error(`Browser launch failed: ${error.message}. Ensure Chromium is installed and executable.`);
    });

    try {
      // Use Promise.all to crawl URLs concurrently
      const crawlPromises = urlsToCrawl.map(async (url) => {
        console.log(`Crawling URL: ${url}`);

        if (!(await canCrawlUrl(url))) {
          console.log(`Skipping ${url} - visited within last 6 hours.`);
          return;
        }

        const page = await browser.newPage();
        try {
          console.log(`Navigating to ${url}`);
          await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
          const content = await page.content();
          const $ = cheerio.load(content);

          // Extract title and text
          const title = $('title').text().trim() || url;
          const text = $('body')
            .find('main, article, section, div:not(:has(script, style, nav))')
            .text()
            .replace(/\s+/g, ' ')
            .trim();

          // Save or update the document in the search index
          const document = {
            id,
            title,
            content: text,
            url,
            timestamp: Date.now(),
          };
          await saveToSearchIndex(crawlId, document);

          // Mark URL as visited
          await markUrlVisited(url);

          // Extract links and add them to the crawl queue
          const links = $('a')
            .map((i, el) => $(el).attr('href'))
            .get()
            .filter((href) => {
              if (!href) return false;
              try {
                const absoluteUrl = new URL(href, url).href;
                return absoluteUrl.startsWith(origin) && !absoluteUrl.includes('#');
              } catch {
                return false;
              }
            })
            .map((href) => new URL(href, url).href);

          // Add new URLs to crawl
          links.forEach((link) => addUrlsToCrawl([link]));
          crawledUrls.push(url);
        } catch (error) {
          console.error(`Failed to crawl ${url}:`, error.message);
        } finally {
          await page.close();
        }
      });

      // Wait for all crawl promises to finish
      await Promise.all(crawlPromises);

      console.log(`Crawl complete. Crawled ${crawledUrls.length} pages.`);
      return NextResponse.json({
        message: 'Crawl complete',
        crawlId,
        pagesCrawled: crawledUrls.length,
        crawledUrls,
      });
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error('Crawl error:', error.message);
    return NextResponse.json({ error: 'Failed to crawl', details: error.message }, { status: 500 });
  }
}
