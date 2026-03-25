import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocation } from "wouter";
import { CheckCircle2, BarChart3, Zap, Shield } from "lucide-react";

export default function Home() {
  const [, navigate] = useLocation();

  const features = [
    {
      icon: Zap,
      title: "LLM-Friendly HTML",
      description: "Analyze content structure and readability for AI processing",
    },
    {
      icon: Shield,
      title: "W3C Compliance",
      description: "Check HTML/CSS standards and web compliance",
    },
    {
      icon: BarChart3,
      title: "SEO Optimization",
      description: "Evaluate search engine optimization and meta tags",
    },
    {
      icon: CheckCircle2,
      title: "Semantic HTML",
      description: "Assess proper use of HTML5 semantic elements",
    },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      {/* Navigation */}
      <nav className="border-b bg-white shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-6 w-6 text-blue-600" />
            <span className="text-xl font-bold text-slate-900">Page Audit Agent</span>
          </div>
          <div>
            <Button onClick={() => navigate("/audit")} variant="default">
              Start Audit
            </Button>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="max-w-6xl mx-auto px-4 py-16 md:py-24">
        <div className="text-center mb-12">
          <h1 className="text-5xl md:text-6xl font-bold text-slate-900 mb-4">
            Comprehensive Page Auditing
          </h1>
          <p className="text-xl text-slate-600 mb-8">
            Score your web pages on LLM-friendliness, W3C compliance, SEO, semantic HTML, and accessibility
          </p>
          <Button size="lg" onClick={() => navigate("/audit")} className="px-8">
            Start Auditing Now
          </Button>
        </div>

        {/* Features Grid */}
        <div className="grid md:grid-cols-2 gap-6 mb-16">
          {features.map((feature, idx) => {
            const Icon = feature.icon;
            return (
              <Card key={idx} className="hover:shadow-lg transition-shadow">
                <CardHeader>
                  <div className="flex items-center gap-3 mb-2">
                    <Icon className="h-6 w-6 text-blue-600" />
                    <CardTitle>{feature.title}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-slate-600">{feature.description}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Additional Features */}
        <Card className="bg-blue-50 border-blue-200">
          <CardHeader>
            <CardTitle className="text-blue-900">Accessibility Compliance</CardTitle>
            <CardDescription className="text-blue-800">
              Comprehensive WCAG compliance checking including color contrast, ARIA attributes, and keyboard navigation
            </CardDescription>
          </CardHeader>
        </Card>
      </section>

      {/* How It Works */}
      <section className="bg-white border-t">
        <div className="max-w-6xl mx-auto px-4 py-16">
          <h2 className="text-3xl font-bold text-slate-900 mb-12 text-center">How It Works</h2>
          <div className="grid md:grid-cols-3 gap-8">
            <div className="text-center">
              <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold text-lg mx-auto mb-4">
                1
              </div>
              <h3 className="font-semibold text-lg mb-2">Enter URL</h3>
              <p className="text-slate-600">Provide the URL of the page you want to audit</p>
            </div>
            <div className="text-center">
              <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold text-lg mx-auto mb-4">
                2
              </div>
              <h3 className="font-semibold text-lg mb-2">Comprehensive Analysis</h3>
              <p className="text-slate-600">Our agents analyze your page across multiple dimensions</p>
            </div>
            <div className="text-center">
              <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold text-lg mx-auto mb-4">
                3
              </div>
              <h3 className="font-semibold text-lg mb-2">Get Detailed Report</h3>
              <p className="text-slate-600">Receive scores and actionable recommendations for improvement</p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-slate-900 text-slate-300 py-8">
        <div className="max-w-6xl mx-auto px-4 text-center">
          <p>&copy; 2026 Page Audit Agent. Powered by Manus AI.</p>
        </div>
      </footer>
    </div>
  );
}
