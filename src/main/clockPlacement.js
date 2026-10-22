import {
    getFileMtimeAndSize,
    getVisibleCoverViewport,
    blendPixbufs,
    loadScaledWallpaperPixbuf,
    resolveWallpaperSource,
} from './wallpaperUtils.js';
import {
    DATETIME_TOP_FRACTION,
    CLOCK_PLACEMENT_MIN_FRACTION,
    CLOCK_PLACEMENT_MAX_FRACTION,
    CLOCK_PLACEMENT_STEP,
    CLOCK_PLACEMENT_DISTANCE_PENALTY,
    CLOCK_PLACEMENT_MIN_GAIN,
} from './constants.js';

const SAMPLE_SIZE = 320;
const _placementCache = new Map();

/**
 * Per-row edge energy over the clock's horizontal span: mean absolute luminance
 * gradient, 0 for flat areas and larger for text, faces and other detail.
 */
function rowEdgeEnergy(pixbuf, viewport, spanX1, spanX2) {
    const pixels = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();
    const pbW = pixbuf.get_width();
    const pbH = pixbuf.get_height();

    const xStart = Math.max(0, Math.round(viewport.visibleX + viewport.visibleW * spanX1));
    const xEnd = Math.min(pbW - 1, Math.round(viewport.visibleX + viewport.visibleW * spanX2));
    const yStart = Math.max(0, Math.floor(viewport.visibleY));
    const yEnd = Math.min(pbH - 1, Math.ceil(viewport.visibleY + viewport.visibleH));

    const lum = (x, y) => {
        const o = y * rowstride + x * channels;
        return (0.2126 * pixels[o] + 0.7152 * pixels[o + 1] + 0.0722 * pixels[o + 2]) / 255;
    };

    const energy = new Float64Array(yEnd - yStart + 1);
    for (let y = yStart; y < yEnd; y++) {
        let sum = 0;
        for (let x = xStart; x < xEnd; x++) {
            const l = lum(x, y);
            sum += Math.abs(l - lum(x + 1, y)) + Math.abs(l - lum(x, y + 1));
        }
        energy[y - yStart] = sum / Math.max(1, xEnd - xStart);
    }
    return energy;
}

/**
 * Picks the top edge (as a fraction of monitor height) where the clock sits over
 * the calmest part of the wallpaper. Stays at the default position unless a
 * candidate is clearly calmer, so a busy-everywhere wallpaper never makes the
 * clock jump around.
 *
 * @param {object} params
 * @param {string} params.uri Wallpaper URI or path
 * @param {string} params.pictureOptions GSettings picture-options value
 * @param {number} params.monitorWidth
 * @param {number} params.monitorHeight
 * @param {number} params.clockWidth Clock width in logical px
 * @param {number} params.clockHeight Clock height in logical px
 * @returns {Promise<number>} Top fraction in [CLOCK_PLACEMENT_MIN, CLOCK_PLACEMENT_MAX]
 */
export async function findCalmClockFraction({
    uri, pictureOptions, monitorWidth, monitorHeight, clockWidth, clockHeight,
}) {
    const { targetFilePath, transitionInfo } = await resolveWallpaperSource(uri);
    if (!targetFilePath)
        return DATETIME_TOP_FRACTION;

    const info = await getFileMtimeAndSize(targetFilePath);
    const key = [targetFilePath, info?.mtime, info?.size, transitionInfo?.progress ?? '',
        pictureOptions, monitorWidth, monitorHeight, clockWidth, clockHeight].join('|');
    if (_placementCache.has(key))
        return _placementCache.get(key);

    let pixbuf;
    if (transitionInfo?.isTransition && transitionInfo.from && transitionInfo.to) {
        const [pbFrom, pbTo] = await Promise.all([
            loadScaledWallpaperPixbuf(transitionInfo.from, SAMPLE_SIZE, SAMPLE_SIZE, true),
            loadScaledWallpaperPixbuf(transitionInfo.to, SAMPLE_SIZE, SAMPLE_SIZE, true),
        ]);
        pixbuf = blendPixbufs(pbFrom, pbTo, transitionInfo.progress);
    } else {
        pixbuf = await loadScaledWallpaperPixbuf(targetFilePath, SAMPLE_SIZE, SAMPLE_SIZE, true);
    }

    const viewport = getVisibleCoverViewport(
        pixbuf.get_width(), pixbuf.get_height(), monitorWidth, monitorHeight, pictureOptions);
    const halfSpan = Math.min(0.5, clockWidth / monitorWidth / 2);
    const energy = rowEdgeEnergy(pixbuf, viewport, 0.5 - halfSpan, 0.5 + halfSpan);

    // Rows of the pixbuf per unit of monitor height, and the clock's height in rows.
    const rowsPerFraction = viewport.visibleH;
    const clockRows = Math.max(1, Math.round(rowsPerFraction * clockHeight / monitorHeight));
    const originRow = Math.floor(viewport.visibleY);

    const prefix = new Float64Array(energy.length + 1);
    for (let i = 0; i < energy.length; i++)
        prefix[i + 1] = prefix[i] + energy[i];

    const scoreAt = fraction => {
        const start = Math.max(0, Math.round(viewport.visibleY + rowsPerFraction * fraction) - originRow);
        const end = Math.min(energy.length, start + clockRows);
        return end > start ? (prefix[end] - prefix[start]) / (end - start) : Infinity;
    };

    const defaultScore = scoreAt(DATETIME_TOP_FRACTION);
    let best = DATETIME_TOP_FRACTION;
    let bestWeighted = defaultScore;
    for (let f = CLOCK_PLACEMENT_MIN_FRACTION; f <= CLOCK_PLACEMENT_MAX_FRACTION + 1e-9; f += CLOCK_PLACEMENT_STEP) {
        const weighted = scoreAt(f)
            * (1 + CLOCK_PLACEMENT_DISTANCE_PENALTY * Math.abs(f - DATETIME_TOP_FRACTION) / DATETIME_TOP_FRACTION);
        if (weighted < bestWeighted) {
            bestWeighted = weighted;
            best = f;
        }
    }

    const result = bestWeighted < defaultScore * (1 - CLOCK_PLACEMENT_MIN_GAIN)
        ? Math.round(best * 1000) / 1000
        : DATETIME_TOP_FRACTION;

    _placementCache.set(key, result);
    if (_placementCache.size > 32)
        _placementCache.delete(_placementCache.keys().next().value);
    return result;
}
