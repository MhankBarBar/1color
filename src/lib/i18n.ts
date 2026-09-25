// English is the default locale; Japanese is the second.
//
// Copy rules for this file: one string per thing the user sees, no restating
// what a control already says, and no marketing sentences. Anything that only
// repeated another string was deleted rather than translated twice.

import type { Dict, Locale, LocaleId } from './types.js';

export const dict: Record<LocaleId, Dict> = {
	en: {
		'nav.editor': 'Editor',
		'nav.accents': 'Colors',
		'nav.live': 'Live',
		'lang.switch': 'Language',

		'hero.title.pre': 'Keep ',
		'hero.title.accent': 'one color',
		'hero.title.post': ', lose the rest.',
		'hero.sub': 'Tap any color in a photo. Everything outside it turns black and white.',
		'hero.open': 'Open a photo',
		'hero.samples': 'Try a sample',

		'stage.drop': 'Drop a photo, paste, or pick one',
		'stage.browse': 'Choose a photo',
		'stage.hint': 'Drag across the photo to move the color.',
		'editor.coverage': 'Share of the photo keeping its color',
		'stage.error': 'That file could not be read. Try a JPEG, PNG, or WebP.',
		'stage.nogl':
			'This browser has WebGL switched off, which the editor needs. Enable hardware acceleration, or try another browser.',

		'panel.accent': 'Color',
		'panel.range': 'Range',
		'panel.mono': 'Mono',
		'panel.output': 'Output',

		'accent.width': 'Color range',
		'accent.feather': 'Edge feather',
		'accent.palette': 'Colors in this photo',
		'accent.recent': 'Recent',
		'panel.hide': 'Hide controls',
		'panel.show': 'Show controls',

		'range.all': 'Whole photo',
		'range.part': 'Part',
		'range.circle': 'Circle',
		'range.square': 'Square',
		'range.lasso': 'Enclose',
		'range.brush': 'Paint',
		'range.brushSize': 'Brush',
		'range.clear': 'Clear shape',

		'mono.standard': 'Standard',
		'mono.soft': 'Soft',
		'mono.deep': 'Deep',
		'mono.high': 'High',
		'mono.tone': 'Tone',
		'mono.contrast': 'Contrast',

		'out.frame': 'Frame',
		'out.frame.none': 'None',
		'out.frame.white': 'White',
		'out.frame.black': 'Black',
		'out.frame.accent': 'Color',
		'out.frame.custom': 'Custom',
		'out.frame.cheki': 'Instant print',
		'out.overlays': 'On the image',
		'out.swatch': 'Swatch',
		'out.code': 'Code',
		'out.comp': 'Color mix',
		'out.align': 'Position',
		'out.align.left': 'Left',
		'out.align.center': 'Center',
		'out.align.right': 'Right',
		'out.ratio': 'Ratio',
		'out.ratio.original': 'Original',
		'out.margin': 'Margin',
		'out.quality': 'Size',
		'out.quality.std': 'Standard',
		'out.quality.max': 'Maximum',
		'out.save': 'Save',
		'out.share': 'Share',
		'out.saved': 'Saved',
		'out.shared': 'Shared',
		'out.failed': 'Could not build the image. Try a smaller size, or reload the page.',
		'out.reset': 'Reset',

		'compare.toggle': 'Compare with the original',
		'compare.handle': 'Drag to compare',

		'accents.title': 'One photo, four colors.',
		'accents.original': 'Original',
		'accents.petals': 'Petals',
		'accents.leaves': 'Leaves',
		'accents.sky': 'Sky',
		'accents.shade': 'Shade',

		'live.title': 'Keep a color live from the camera.',
		'live.sub': 'Tap the preview to choose the color, then shoot.',
		'live.start': 'Turn on the camera',
		'live.stop': 'Turn off',
		'live.capture': 'Capture',
		'live.denied': 'Camera access is blocked. Allow it for this site, then try again.',
		'live.unsupported': 'This browser cannot reach the camera.',
		'live.privacy': 'The video never leaves this device.',
		'live.waiting': 'Starting the camera…',

		'footer.built': 'Keep one color. Lose the rest.',
		'footer.disclaimer':
			'1color is an independent project, not affiliated with or endorsed by the Accent iOS app by AKIRA SANO.',
		'footer.photos': 'Photos: Wikimedia Commons',
		'footer.iosapp': 'The iOS app it was inspired by'
	},

	ja: {
		'nav.editor': 'エディタ',
		'nav.accents': '色の選び方',
		'nav.live': 'ライブ',
		'lang.switch': '言語',

		'hero.title.pre': '残すのは、',
		'hero.title.accent': 'ひとつの色',
		'hero.title.post': 'だけ。',
		'hero.sub': '写真の中の色をタップするだけ。それ以外はモノクロになります。',
		'hero.open': '写真を開く',
		'hero.samples': 'サンプルで試す',

		'stage.drop': '写真をドロップ、貼り付け、または選択',
		'stage.browse': '写真を選ぶ',
		'stage.hint': '写真をなぞると、残す色が移り変わります。',
		'editor.coverage': '色が残る面積',
		'stage.error': 'このファイルは読み込めませんでした。JPEG・PNG・WebPをお試しください。',
		'stage.nogl':
			'このブラウザではWebGLが無効になっています。ハードウェアアクセラレーションを有効にするか、別のブラウザをお試しください。',

		'panel.accent': '色',
		'panel.range': '範囲',
		'panel.mono': 'モノクロ',
		'panel.output': '出力',

		'accent.width': '残す色の幅',
		'accent.feather': '境界のぼかし',
		'accent.palette': 'この写真の色',
		'accent.recent': '最近使った色',
		'panel.hide': '操作パネルを閉じる',
		'panel.show': '操作パネルを開く',

		'range.all': '写真全体',
		'range.part': '一部分',
		'range.circle': '円',
		'range.square': '四角',
		'range.lasso': '囲む',
		'range.brush': '塗る',
		'range.brushSize': 'ブラシ',
		'range.clear': '範囲をクリア',

		'mono.standard': '標準',
		'mono.soft': 'ソフト',
		'mono.deep': '深め',
		'mono.high': '強め',
		'mono.tone': 'トーン',
		'mono.contrast': 'コントラスト',

		'out.frame': 'フレーム',
		'out.frame.none': 'なし',
		'out.frame.white': '白',
		'out.frame.black': '黒',
		'out.frame.accent': '色',
		'out.frame.custom': 'カスタム',
		'out.frame.cheki': 'チェキ風',
		'out.overlays': '写真に載せる',
		'out.swatch': '色見本',
		'out.code': 'カラーコード',
		'out.comp': '色構成',
		'out.align': '位置',
		'out.align.left': '左',
		'out.align.center': '中央',
		'out.align.right': '右',
		'out.ratio': 'アスペクト比',
		'out.ratio.original': '元のまま',
		'out.margin': '余白',
		'out.quality': '画質',
		'out.quality.std': '標準',
		'out.quality.max': '最大',
		'out.save': '保存',
		'out.share': '共有',
		'out.saved': '保存しました',
		'out.shared': '共有しました',
		'out.failed': '画像を作成できませんでした。サイズを小さくするか、ページを再読み込みしてください。',
		'out.reset': 'リセット',

		'compare.toggle': '元の写真と比較',
		'compare.handle': 'ドラッグして比較',

		'accents.title': '同じ一枚を、四つの色で。',
		'accents.original': '元の写真',
		'accents.petals': '花びら',
		'accents.leaves': '葉',
		'accents.sky': '空',
		'accents.shade': '影',

		'live.title': 'カメラの色を、そのまま残す。',
		'live.sub': 'プレビューをタップして色を選び、撮影します。',
		'live.start': 'カメラをオンにする',
		'live.stop': 'オフにする',
		'live.capture': '撮影',
		'live.denied': 'カメラがブロックされています。このサイトに許可してから、もう一度お試しください。',
		'live.unsupported': 'このブラウザではカメラを利用できません。',
		'live.privacy': '映像は端末の外に出ません。',
		'live.waiting': 'カメラを起動しています…',

		'footer.built': '残すのは、ひとつの色だけ。',
		'footer.disclaimer':
			'「1color」は独立したプロジェクトです。AKIRA SANO 氏のiOSアプリ「Accent - Selective Color」とは関係ありません。',
		'footer.photos': '写真: Wikimedia Commons',
		'footer.iosapp': '参考にしたiOSアプリ'
	}
};

export const locales: Locale[] = [
	{ id: 'en', label: 'EN' },
	{ id: 'ja', label: '日本語' }
];
