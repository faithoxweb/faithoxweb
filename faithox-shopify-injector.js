(function() {
    // 1. Only run this if the customer is on a Product Page
    if (window.location.pathname.includes('/products/')) {
        
        // 2. Securely grab the Shopify Product ID from Shopify's global variables
        const productId = window.ShopifyAnalytics?.meta?.product?.id || window.meta?.product?.id;
        
        if (productId) {
            console.log("Faithox: Found Product ID", productId);

            // 3. Prevent duplicate injections
            if (document.getElementById('faithox-auto-widget')) return;

            // 4. Generate the secure iframe dynamically
            const faithoxIframe = document.createElement('iframe');
            faithoxIframe.src = `https://www.faithox.com/embed.html?product_id=${productId}`;
            faithoxIframe.style.width = '100%';
            faithoxIframe.style.height = '600px'; 
            faithoxIframe.style.border = 'none';
            faithoxIframe.style.borderRadius = '24px';
            faithoxIframe.style.marginTop = '40px';
            faithoxIframe.style.marginBottom = '40px';
            faithoxIframe.scrolling = 'no';
            faithoxIframe.id = 'faithox-auto-widget';

            // 5. Find the best spot to inject it (usually below the product description)
            const injectionTarget = document.querySelector('.product__description') || 
                                    document.querySelector('.product-single__description') || 
                                    document.querySelector('.product-info') ||
                                    document.querySelector('.product__info-container') ||
                                    document.querySelector('main');
            
            if (injectionTarget) {
                // Drop the iframe securely onto the page!
                injectionTarget.parentNode.insertBefore(faithoxIframe, injectionTarget.nextSibling);
                console.log("Faithox: Widget successfully injected!");
            }
        }
    }
})();
