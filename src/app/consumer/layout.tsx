// src/app/consumer/layout.tsx
import FlowAssistantWidget from '@/src/components/FlowAssistantWidget';

export default function ConsumerLayout({ children }: { children: React.ReactNode }) {
    return (
        <>
            {children}
            <FlowAssistantWidget />
        </>
    );
}
