/** Unicode UI icons work across Slack text surfaces; code and custom aliases stay literal. */
const icons: Record<string, string> = {
  framed_picture: "🖼️", frame_with_picture: "🖼️", warning: "⚠️", rotating_light: "🚨",
  white_check_mark: "✅", no_entry: "⛔", x: "❌", alarm_clock: "⏰", arrow_forward: "▶️",
  small_orange_diamond: "🔸", mute: "🔇", arrows_counterclockwise: "🔄",
  eye_in_speech_bubble: "👁️", hammer_and_wrench: "🛠️", hourglass_flowing_sand: "⏳", hourglass: "⌛",
};
export function unicodeEmoji(text: string): string {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, i) => i % 2 ? part
    : part.replace(/:([a-z_]+):/g, (alias, name: string) => icons[name] ?? alias)).join("");
}
