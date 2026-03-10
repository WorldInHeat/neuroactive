type Props = {
  imageSrc: string;
  title: string;
  caption: string;
};

export default function InfoCard({ imageSrc, title, caption }: Props) {
  return (
    <div
      className="rounded-2xl overflow-hidden border border-[#1a2a42]"
      style={{ background: '#0f1829' }}
    >
      <img
        src={imageSrc}
        alt={title}
        className="w-full object-cover"
        style={{ maxHeight: 260 }}
      />
      <div className="p-4">
        <p className="font-semibold text-[#f0f4f8] text-sm mb-1">{title}</p>
        <p className="text-xs text-[#6b849e] leading-relaxed">{caption}</p>
      </div>
    </div>
  );
}
