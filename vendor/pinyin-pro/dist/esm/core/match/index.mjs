import { splitString } from '../../common/utils.mjs';
import { getAllPinyin } from '../pinyin/all.mjs';

const DefaultMatchOptions = {
    precision: "first",
    continuous: false,
    space: "ignore",
    lastPrecision: "start",
    insensitive: true,
    v: false,
};
const MAX_PINYIN_LENGTH = 6;
// match 只需要单字多音结果，不需要经过完整的词组匹配流程。
const TONE_MAP = {
    "ā": "a", "á": "a", "ǎ": "a", "à": "a",
    "ō": "o", "ó": "o", "ǒ": "o", "ò": "o",
    "ē": "e", "é": "e", "ě": "e", "è": "e",
    "ī": "i", "í": "i", "ǐ": "i", "ì": "i",
    "ū": "u", "ú": "u", "ǔ": "u", "ù": "u",
    "ǖ": "ü", "ǘ": "ü", "ǚ": "ü", "ǜ": "ü",
    "n̄": "n", "ń": "n", "ň": "n", "ǹ": "n",
    "m̄": "m", "ḿ": "m", "m̌": "m", "m̀": "m",
    "ê̄": "ê", "ế": "ê", "ê̌": "ê", "ề": "ê",
};
const TONE_RE = new RegExp(Object.keys(TONE_MAP).join("|"), "g");
const stripTone = (pinyin) => pinyin.replace(TONE_RE, (ch) => TONE_MAP[ch]);
const getMatchPinyin = (char, options) => {
    const pinyins = getAllPinyin(char);
    return (pinyins.length ? pinyins : [char]).map((pinyin) => {
        const withoutTone = stripTone(pinyin);
        return options.v
            ? withoutTone.replace(/ü/g, typeof options.v === "string" ? options.v : "v")
            : withoutTone;
    });
};
/**
 * @description: 检测汉语字符串和拼音是否匹配
 * @param {string} text 汉语字符串
 * @param {string} pinyin 拼音，支持各种缩写形式
 * @param {MatchOptions=} options 配置项
 * @return {Array | null} 若匹配成功，返回 text 中匹配成功的下标数组；若匹配失败，返回 null
 */
const match = (text, pinyin, options) => {
    if ((options === null || options === void 0 ? void 0 : options.precision) === "any") {
        options.lastPrecision = "any";
    }
    if (options === null || options === void 0 ? void 0 : options.v) {
        const replacement = typeof options.v === "string" ? options.v : "v";
        pinyin = pinyin.replace(/ü/g, replacement);
    }
    const completeOptions = Object.assign(Object.assign({}, DefaultMatchOptions), (options || {}));
    // 是否大小写不敏感
    if (completeOptions.insensitive !== false) {
        text = text.toLowerCase();
        pinyin = pinyin.toLowerCase();
    }
    // 移除空格
    if (completeOptions.space === "ignore") {
        pinyin = pinyin.replace(/\s/g, "");
    }
    const words = splitString(text);
    const result = (options === null || options === void 0 ? void 0 : options.precision) === "any"
        ? matchAny(words, pinyin, completeOptions)
        : matchAboveStart(words, pinyin, completeOptions);
    return processDoubleUnicodeIndex(words, result);
};
// 检测两个拼音最大的匹配长度
const getMatchLength = (pinyin1, pinyin2) => {
    let length = 0;
    for (let i = 0; i < pinyin1.length; i++) {
        if (pinyin1[i] === pinyin2[length]) {
            length++;
        }
    }
    return length;
};
const matchAny = (words, pinyin, options) => {
    let result = [];
    const ignoreSpace = options.space === "ignore";
    for (let i = 0; i < words.length; i++) {
        // 空格字符
        if (ignoreSpace && words[i] === " ") {
            result.push(i);
            continue;
        }
        // 是否为中文匹配
        if (words[i] === pinyin[0]) {
            pinyin = pinyin.slice(1);
            result.push(i);
            continue;
        }
        // 当前字的多音字拼音
        const ps = getMatchPinyin(words[i], options);
        let currentLength = 0;
        ps.forEach((p) => {
            const length = getMatchLength(p, pinyin);
            if (length > currentLength) {
                currentLength = length;
            }
        });
        if (currentLength) {
            pinyin = pinyin.slice(currentLength);
            result.push(i);
        }
        if (!pinyin) {
            break;
        }
    }
    // 未匹配完
    if (pinyin) {
        return null;
    }
    // 是否连续
    if (options.continuous) {
        const _result = result;
        const isNotContinuous = result.some((val, index) => index > 0 && val !== _result[index - 1] + 1);
        if (isNotContinuous) {
            return null;
        }
    }
    if (options.space === "ignore") {
        result = result.filter((i) => words[i] !== " ");
    }
    return result.length ? result : null;
};
const appendMatchPath = (previous, index) => ({
    previous,
    index,
    length: previous.length + 1,
});
function restoreMatchPath(path) {
    const result = Array(path.length);
    while (path.previous) {
        result[path.length - 1] = path.index;
        path = path.previous;
    }
    return result;
}
const matchAboveStart = (words, pinyin, options) => {
    var _a, _b, _c, _d, _e, _f, _g;
    // Shared paths must stay immutable because multiple states can reference them.
    const rootPath = { previous: null, index: -1, length: 0 };
    let pre = Array(pinyin.length + 1);
    for (let i = 0; i < pre.length; i++) {
        pre[i] = rootPath;
    }
    // 动态规划匹配
    for (let i = 1; i <= words.length; i++) {
        const current = Array(pinyin.length + 1);
        current[0] = rootPath;
        // options.continuous 为 false 或 options.space 为 ignore 且当前为空格时，第 i 个字可以不参与匹配
        if (!options.continuous ||
            (options.space == "ignore" && words[i - 1] === " ")) {
            for (let j = 1; j <= pinyin.length; j++) {
                current[j - 1] = pre[j - 1];
            }
        }
        // 当前字符的拼音 forms 只依赖字符和 options，与 j 无关。
        // 按需计算一次，既复用结果，也保留无可达状态时的短路。
        let muls;
        // 第 i 个字参与匹配
        for (let j = 1; j <= pinyin.length; j++) {
            const previous = pre[j - 1];
            if (!previous) {
                // 第 i - 1 已经匹配失败，停止向后匹配
                continue;
            }
            else if (j !== 1 && !previous.length) {
                // 非开头且前面的字符未匹配完成，停止向后匹配
                continue;
            }
            else {
                muls !== null && muls !== void 0 ? muls : (muls = getMatchPinyin(words[i - 1], options));
                // 非中文匹配
                if (words[i - 1] === pinyin[j - 1]) {
                    const matches = appendMatchPath(previous, i - 1);
                    // 记录最长的可匹配下标数组
                    if (matches.length > ((_b = (_a = current[j]) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : -1)) {
                        current[j] = matches;
                    }
                    // pinyin 参数完全匹配完成，记录结果
                    if (j === pinyin.length) {
                        return restoreMatchPath((_c = current[j]) !== null && _c !== void 0 ? _c : matches);
                    }
                }
                // 剩余长度小于等于 MAX_PINYIN_LENGTH(6) 时，有可能是最后一个拼音了
                if (pinyin.length - j <= MAX_PINYIN_LENGTH) {
                    const remainingLength = pinyin.length - j + 1;
                    const remainingPinyin = pinyin.slice(j - 1);
                    // lastPrecision 参数处理
                    const last = muls.some((py) => {
                        if (options.lastPrecision === "any") {
                            return py.includes(remainingPinyin);
                        }
                        if (options.lastPrecision === "start") {
                            return py.startsWith(remainingPinyin);
                        }
                        if (options.lastPrecision === "first") {
                            return remainingLength === 1 && py[0] === pinyin[j - 1];
                        }
                        if (options.lastPrecision === "every") {
                            return (py.length === remainingLength && pinyin.startsWith(py, j - 1));
                        }
                        return false;
                    });
                    if (last) {
                        return restoreMatchPath(appendMatchPath(previous, i - 1));
                    }
                }
                const precision = options.precision;
                // precision 为 start 时，匹配开头
                if (precision === "start") {
                    muls.forEach((py) => {
                        var _a, _b;
                        let end = j;
                        const matches = appendMatchPath(previous, i - 1);
                        while (end <= pinyin.length &&
                            py.startsWith(pinyin.slice(j - 1, end))) {
                            if (matches.length > ((_b = (_a = current[end]) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : -1)) {
                                current[end] = matches;
                            }
                            end++;
                        }
                    });
                }
                // precision 为 first 时，匹配首字母
                if (precision === "first") {
                    if (muls.some((py) => py[0] === pinyin[j - 1])) {
                        const matches = appendMatchPath(previous, i - 1);
                        // 记录最长的可匹配下标数组
                        if (matches.length > ((_e = (_d = current[j]) === null || _d === void 0 ? void 0 : _d.length) !== null && _e !== void 0 ? _e : -1)) {
                            current[j] = matches;
                        }
                    }
                }
                // 匹配当前汉字的完整拼音
                const completeMatch = muls.find((py) => pinyin.startsWith(py, j - 1));
                if (completeMatch) {
                    const matches = appendMatchPath(previous, i - 1);
                    const endIndex = j - 1 + completeMatch.length;
                    // 记录最长的可匹配下标数组
                    if (matches.length > ((_g = (_f = current[endIndex]) === null || _f === void 0 ? void 0 : _f.length) !== null && _g !== void 0 ? _g : -1)) {
                        current[endIndex] = matches;
                    }
                }
            }
        }
        pre = current;
    }
    return null;
};
// 对于双字节的字符，需要将 index 顺延 +1
function processDoubleUnicodeIndex(words, indexArray) {
    if (!indexArray) {
        return null;
    }
    const result = [];
    let doubleUnicodeCount = 0;
    let i = 0;
    for (let j = 0; j < indexArray.length; j++) {
        const curIndex = indexArray[j];
        while (i <= curIndex) {
            if (words[i].length === 2) {
                doubleUnicodeCount++;
            }
            i++;
        }
        const realIndex = curIndex + doubleUnicodeCount;
        if (words[curIndex].length === 2) {
            result.push(realIndex - 1, realIndex);
        }
        else {
            result.push(realIndex);
        }
    }
    return result;
}

export { match };
