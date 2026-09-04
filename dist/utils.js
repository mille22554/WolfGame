/**
 * Utility Functions
 */
import * as readline from 'readline';
/**
 * Fisher-Yates shuffle
 */
export function shuffleArray(array) {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}
/**
 * Prompt user for input in CLI
 */
export async function prompt(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}
/**
 * Random integer [min, max] inclusive
 */
export function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
/**
 * Pick random element from array
 */
export function pickRandom(array) {
    return array[randomInt(0, array.length - 1)];
}
/**
 * Pick random element from array, excluding certain elements
 */
export function pickRandomExcluding(array, exclude) {
    const filtered = array.filter(item => !exclude.includes(item));
    if (filtered.length === 0)
        return null;
    return pickRandom(filtered);
}
/**
 * Count occurrences in array
 */
export function countOccurrences(array) {
    const counts = new Map();
    for (const item of array) {
        counts.set(item, (counts.get(item) || 0) + 1);
    }
    return counts;
}
/**
 * Find player by ID
 */
export function findPlayerById(players, id) {
    return players.find(p => p.id === id);
}
/**
 * Sleep for milliseconds
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/**
 * Format player list for display
 */
export function formatPlayerList(players) {
    return players
        .map(p => `${p.name}${p.alive ? '' : ' ☠'}`)
        .join('、');
}
/**
 * Get majority threshold for voting
 */
export function getMajorityThreshold(aliveCount) {
    return Math.floor(aliveCount / 2) + 1;
}
/**
 * Check if vote has majority
 */
export function hasMajority(votes, aliveCount) {
    return votes >= getMajorityThreshold(aliveCount);
}
//# sourceMappingURL=utils.js.map